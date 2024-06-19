const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const awsx = require("@pulumi/awsx");

(async function main() {
	/**
	 * PART ONE: PERMISSIONS
	 * @type {Promise<GetPolicyDocumentResult>}
	 */

	const vpc = await aws.ec2.getVpc({ default: true });
	const vpcId = vpc.id;
	const subnets = await aws.ec2.getSubnets({
		filters: [{ name: "vpc-id", values: [vpcId] }],
	});
	const subnetIds = subnets.ids;
	const assumeRolePolicy = aws.iam.getPolicyDocument({
		statements: [
			{
				actions: ["sts:AssumeRole"],
				principals: [
					{
						type: "Service",
						identifiers: ["ecs-tasks.amazonaws.com"],
					},
				],
			},
		],
	});

	const ecsTaskExecutionRole = new aws.iam.Role("ecs-role", {
		assumeRolePolicy: assumeRolePolicy.then((res) => res.json),
	});

	const policyDocument = pulumi.output({
		Version: "2012-10-17",
		Statement: [
			{
				Effect: "Allow",
				Action: [
					"ecr:GetAuthorizationToken",
					"ecr:BatchCheckLayerAvailability",
					"ecr:GetDownloadUrlForLayer",
					"ecr:BatchGetImage",
					"logs:CreateLogStream",
					"logs:CreateLogGroup",
					"logs:PutLogEvents",
				],
				Resource: "*",
			},
		],
	});

	const policy = new aws.iam.Policy("ecs-policy", {
		policy: policyDocument.apply(JSON.stringify),
	});

	const ecsTaskExecutionRolePolicy = new aws.iam.RolePolicyAttachment(
		"ecs-policy-attachment",
		{
			role: ecsTaskExecutionRole.name,
			policyArn: policy.arn,
		}
	);

	const ecsSecurityGroup = new aws.ec2.SecurityGroup("ecs-sec-group", {
		vpcId: vpcId,
		ingress: [
			{ protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
		],
		egress: [
			{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
		],
	});

	const executionRoleArn = ecsTaskExecutionRole.arn;

	/**
	 * PART TWO: BUILDING THE APP & DOCKER IMAGE
	 */

	const repo = new awsx.ecr.Repository("node-api-repo", {
		forceDelete: true,
		name: "node-api-repo",
		lifecyclePolicy: {
			rules: [{ maximumNumberOfImages: 10, tagStatus: "any" }],
		},
	});

	const image = new awsx.ecr.Image("node-api-image", {
		repositoryUrl: repo.url,
		path: "./",
		imageBuildOptions: {
			platform: "linux/amd64", // Specify the platform you want to build for
		},
	});

	/**
	 * PART THREE: ECS SETUP WITH DOCKER IMAGE
	 */

	const cluster = new aws.ecs.Cluster("node-api-cluster", {
		capacityProviders: ["FARGATE"], //  Fargate mode can be chosen here
		defaultCapacityProviderStrategies: [
			{
				capacityProvider: "FARGATE",
				weight: 1,
				base: 1,
			},
		],
		settings: [
			{
				name: "containerInsights",
				value: "enabled",
			},
		],
	});

	const lb = new aws.lb.LoadBalancer("node-api-lb", {
		internal: false,
		loadBalancerType: "application",
		securityGroups: [ecsSecurityGroup.id],
		subnets: subnetIds,
	});

	const targetGroup = new aws.lb.TargetGroup("node-api-lb-target-group", {
		port: 80,
		protocol: "HTTP",
		targetType: "ip",
		vpcId: vpcId,
		healthCheck: {
			enabled: true,
			path: "/ping/",
			interval: 30,
			timeout: 5,
		},
	});

	const listener = new aws.lb.Listener("node-api-listener", {
		loadBalancerArn: lb.arn,
		port: 80,
		defaultActions: [
			{
				type: "forward",
				targetGroupArn: targetGroup.arn,
			},
		],
	});

	image.imageUri.apply((imageUri) => {
		const taskDefinition = new aws.ecs.TaskDefinition("node-api-task", {
			family: "node-api-family",
			cpu: "256",
			memory: "512",
			networkMode: "awsvpc",
			requiresCompatibilities: ["FARGATE"],
			executionRoleArn: executionRoleArn,
			containerDefinitions: JSON.stringify([
				{
					name: "node-api-container",
					image: imageUri,
					portMappings: [
						{
							containerPort: 80,
							hostPort: 80,
							protocol: "tcp",
						},
					],
					logConfiguration: {
						logDriver: "awslogs",
						options: {
							"awslogs-group": "node-api-container",
							"awslogs-region": "us-east-1",
							"awslogs-create-group": "true",
							"awslogs-stream-prefix": "node-api",
						},
					},
				},
			]),
		});

		const service = new aws.ecs.Service("ecs-service", {
			cluster: cluster.arn,
			desiredCount: 1,
			launchType: "FARGATE",
			healthCheckGracePeriodSeconds: 60,
			taskDefinition: taskDefinition.arn,
			networkConfiguration: {
				assignPublicIp: true,
				subnets: subnetIds,
				securityGroups: [ecsSecurityGroup.id],
			},
			loadBalancers: [
				{
					targetGroupArn: targetGroup.arn,
					containerName: "node-api-container",
					containerPort: 80,
				},
			],
			waitForSteadyState: false,
		});

		/**
		 * PART FOUR: API GATEWAY
		 */

		const api = new aws.apigatewayv2.Api("node-api", {
			protocolType: "HTTP",
			description: "REST API service",
		});

		const getIntegration = new aws.apigatewayv2.Integration(
			"ecs-get-integration",
			{
				apiId: api.id,
				integrationType: "HTTP_PROXY",
				integrationMethod: "GET",
				timeoutMilliseconds: 30000,
				integrationUri: pulumi.interpolate`http://${lb.dnsName}`,
			}
		);

		const usersRoute = new aws.apigatewayv2.Route("get-users", {
			apiId: api.id,
			routeKey: "GET /users",
			target: pulumi.interpolate`integrations/${getIntegration.id}`,
		});

		const deployment = new aws.apigatewayv2.Deployment(
			"v1",
			{
				apiId: api.id,
				description: "V1 API",
			},
			{
				dependsOn: [api, usersRoute], // Ensure that the API is created before trying to deploy
			}
		);

		// const logGroupName = "node-api-logs";
		// const logGroup = new aws.cloudwatch.LogGroup(logGroupName, {
		// 	name: logGroupName,
		// 	retentionInDays: 7,
		// });

		const stage = new aws.apigatewayv2.Stage("dev", {
			apiId: api.id,
			deploymentId: deployment.id,
			name: "dev",
			// accessLogSettings: {
			// 	destinationArn: logGroup.arn,
			// 	format: JSON.stringify({
			// 		request: {
			// 			requestId: "$context.requestId",
			// 			requestTime: "$context.requestTime",
			// 			clientIp: "$context.identity.sourceIp",
			// 			httpMethod: "$context.httpMethod",
			// 			path: "$context.path",
			// 			protocol: "$context.protocol",
			// 			userAgent: "$context.identity.userAgent",
			// 			accountId: "$context.identity.accountId",
			// 			caller: "$context.identity.caller",
			// 			user: "$context.identity.user",
			// 			userArn: "$context.identity.userArn",
			// 		},
			// 		response: {
			// 			statusCode: "$context.status",
			// 			responseLength: "$context.responseLength",
			// 			responseLatency: "$context.responseLatency",
			// 		},
			// 		integration: {
			// 			integrationLatency: "$context.integrationLatency",
			// 			integrationStatus: "$context.integrationStatus",
			// 			integrationErrorMessage: "$context.integrationErrorMessage",
			// 			status: "$context.integration.status",
			// 			statusText: "$context.integration.statusText",
			// 			latency: "$context.integration.latency",
			// 			statusDetails: {
			// 				statusCode: "$context.integration.status",
			// 				protocol: "$context.integration.protocol",
			// 				data: "$context.integration.data",
			// 			},
			// 		},
			// 	}),
			// },
		});
	});
})();

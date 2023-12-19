FROM --platform=linux/amd64 node:20.8.1-alpine as build-alpine-node

WORKDIR /app

# Update package lists and install bash
RUN apk update && \
    apk add bash

# Copy the package.json and package-lock.json files from your system to the working directory in the Docker container.
# http://bitjudo.com/blog/2014/03/13/building-efficient-dockerfiles-node-dot-js/
COPY package.json /app
COPY package-lock.json /app

# Install the Node.js dependencies in the Docker container.
# https://docs.npmjs.com/cli/v10/commands/npm-ci
RUN npm i

COPY . /app

EXPOSE 80

# Run the Express application in the Docker container.
CMD [ "npm", "start" ]




















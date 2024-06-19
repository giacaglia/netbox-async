import AWS from "aws-sdk";
import * as fs from "node:fs";
import os from "os";
import stream from "stream";

import { getTranscript } from "./whisper";

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const path = require("path");

type S3UploadConfig = {
    accessKeyId: string;
    secretAccessKey: string;
    destinationBucketName: string;
    region?: string;
};

type S3UploadStream = {
    writeStream: stream.PassThrough;
    promise: Promise<AWS.S3.ManagedUpload.SendData>;
};

export class AWSS3Uploader {
    private s3: AWS.S3;
    public config: S3UploadConfig;

    constructor(config: S3UploadConfig) {
        AWS.config = new AWS.Config();
        AWS.config.update({
            region: config.region || "us-west-1",
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        });

        this.s3 = new AWS.S3();
        this.config = config;
    }

    private createUploadStream(
        key: string,
        pass: any,
        folder: string
    ): S3UploadStream {
        return {
            writeStream: pass,
            promise: this.s3
                .upload({
                    Bucket: this.config.destinationBucketName + folder,
                    Key: key,
                    Body: pass,
                    ACL: "public-read"
                })
                .promise()
        };
    }

    // Helper function to upload a file to S3
    private async uploadFileToS3(
        localFile: string,
        uploadFilename: string,
        folder: string
    ): Promise<string> {
        const fileData = fs.readFileSync(localFile);

        const uploadResult = await this.s3
            .upload({
                Bucket: this.config.destinationBucketName + folder,
                Key: uploadFilename,
                Body: fileData,
                ACL: "public-read"
            })
            .promise();
        return uploadResult.Location;
    }

    async convertMp4ToWav(
        inputFile: string,
        outputFile: string
    ): Promise<void> {
        console.log("Output file: ", outputFile);
        return new Promise((resolve, reject) => {
            ffmpeg(inputFile)
                .toFormat("wav")
                .audioFrequency(16000)
                .on("error", (err: Error) => {
                    console.log("An error occurred: " + err.message);
                    reject(err);
                })
                .on("progress", (progress: any) => {
                    console.log("Processing: " + progress.percent + "% done");
                })
                .on("end", () => {
                    console.log("Processing finished!");
                    resolve();
                })
                .save(outputFile);
        });
    }

    async uploadTranscriptFile(
        tmpDir: string,
        tempFile: string,
        newFilename: string
    ): Promise<string> {
        const audioFileName = path.join(tmpDir, "audio.wav");

        // Convert mp4 to wav
        await this.convertMp4ToWav(tempFile, audioFileName);

        // Get transcript of audio file
        const transcript = await getTranscript(audioFileName);

        // Need to save the transcript
        const jsonString = JSON.stringify(transcript, null, 2); // pretty print with 2 spaces
        const transcriptFileName = path.join(tmpDir, newFilename + ".json");
        try {
            await fs.promises.writeFile(transcriptFileName, jsonString);
            console.log("Transcript was saved!");
        } catch (err) {
            console.log(err);
        }
        const result = await this.uploadFileToS3(
            transcriptFileName,
            newFilename + ".json",
            "/subtitles"
        );
        return result;
    }

    async transcribeVideo(
        readStream: stream.Readable,
        filename: string
    ): Promise<string> {
        const tmpDir = os.tmpdir();
        const tempFile = path.join(os.tmpdir(), "video.mp4");

        console.log("Transcribing video");
        await new Promise<void>((resolve, reject) => {
            const writeStream = fs.createWriteStream(tempFile, {
                highWaterMark: 10 * 1024 * 1024
            }); // 10MB buffer
            stream.pipeline(readStream, writeStream, (err) => {
                if (err) {
                    console.error("Error writing video file to disk: ", err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        console.log("File written to disk");
        try {
            const transcriptUrl = await this.uploadTranscriptFile(
                tmpDir,
                tempFile,
                filename
            );
            console.log("Transcript uploaded to S3");
            return transcriptUrl;
        } catch (e) {
            console.log("Error with transcribing video:", e);
            return "";
        }
    }
}

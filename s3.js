"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AWSS3Uploader = void 0;
const aws_sdk_1 = __importDefault(require("aws-sdk"));
const fs = __importStar(require("node:fs"));
const os_1 = __importDefault(require("os"));
const stream_1 = __importDefault(require("stream"));
const whisper_1 = require("./whisper");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const path = require("path");
class AWSS3Uploader {
    constructor(config) {
        aws_sdk_1.default.config = new aws_sdk_1.default.Config();
        aws_sdk_1.default.config.update({
            region: config.region || "us-west-1",
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        });
        this.s3 = new aws_sdk_1.default.S3();
        this.config = config;
    }
    createUploadStream(key, pass, folder) {
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
    async uploadFileToS3(localFile, uploadFilename, folder) {
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
    async convertMp4ToWav(inputFile, outputFile) {
        console.log("Output file: ", outputFile);
        return new Promise((resolve, reject) => {
            ffmpeg(inputFile)
                .toFormat("wav")
                .audioFrequency(16000)
                .on("error", (err) => {
                console.log("An error occurred: " + err.message);
                reject(err);
            })
                .on("progress", (progress) => {
                console.log("Processing: " + progress.percent + "% done");
            })
                .on("end", () => {
                console.log("Processing finished!");
                resolve();
            })
                .save(outputFile);
        });
    }
    async uploadTranscriptFile(tmpDir, tempFile, newFilename) {
        const audioFileName = path.join(tmpDir, "audio.wav");
        // Convert mp4 to wav
        await this.convertMp4ToWav(tempFile, audioFileName);
        // Get transcript of audio file
        const transcript = await (0, whisper_1.getTranscript)(audioFileName);
        // Need to save the transcript
        const jsonString = JSON.stringify(transcript, null, 2); // pretty print with 2 spaces
        const transcriptFileName = path.join(tmpDir, newFilename + ".json");
        try {
            await fs.promises.writeFile(transcriptFileName, jsonString);
            console.log("Transcript was saved!");
        }
        catch (err) {
            console.log(err);
        }
        const result = await this.uploadFileToS3(transcriptFileName, newFilename + ".json", "/subtitles");
        return result;
    }
    async transcribeVideo(readStream, filename) {
        const tmpDir = os_1.default.tmpdir();
        const tempFile = path.join(os_1.default.tmpdir(), "video.mp4");
        console.log("Transcribing video");
        await new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(tempFile, {
                highWaterMark: 10 * 1024 * 1024
            }); // 10MB buffer
            stream_1.default.pipeline(readStream, writeStream, (err) => {
                if (err) {
                    console.error("Error writing video file to disk: ", err);
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
        console.log("File written to disk");
        try {
            const transcriptUrl = await this.uploadTranscriptFile(tmpDir, tempFile, filename);
            console.log("Transcript uploaded to S3");
            return transcriptUrl;
        }
        catch (e) {
            console.log("Error with transcribing video:", e);
            return "";
        }
    }
}
exports.AWSS3Uploader = AWSS3Uploader;

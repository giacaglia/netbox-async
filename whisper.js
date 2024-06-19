"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTranscript = exports.parseTranscript = void 0;
const path_1 = __importDefault(require("path"));
const shelljs_1 = __importDefault(require("shelljs"));
function parseTranscript(vtt) {
    // 1. separate lines at timestamp's open bracket
    const lines = vtt.split("\n");
    // 2. remove the first line, which is empty
    lines.shift();
    // 3. remove empty lines
    const nonEmptyLines = lines.filter((line) => line.trim() !== "");
    // 4. convert each line into an object
    const results = lines.map((line) => {
        // 3a. split ts from speech
        let [timestamp, speech] = line.split("]  ");
        // 3b. split timestamp into begin and end
        const [start, end] = timestamp.split(" --> ");
        try {
            // 3c. remove \n from speech with regex
            speech = speech.replace(/\n/g, "");
        }
        catch (e) {
            return null;
        }
        return { start: start.substring(1), end, speech: speech.substring(1) };
    });
    return results.filter((result) => result !== null);
}
exports.parseTranscript = parseTranscript;
// Example calling it const trans = await getTranscript("../public/Regret.wav");
/**
 *
 * @param audioLocation The location of the audio file to be transcribed
 * @returns The transcript of the audio file
 */
async function getTranscript(audioLocation) {
    console.log("Current working directory:", process.cwd());
    shelljs_1.default.cd(path_1.default.join(__dirname, "..", "whisper.cpp-master"));
    console.log("New working directory:", process.cwd());
    // ./samples/jfk.wav
    const command = `./main -m models/ggml-base.en.bin ${audioLocation}`;
    console.log("Command to be executed:", command);
    const transcript = await shelljs_1.default.exec(command);
    console.log("Command execution result:", transcript);
    shelljs_1.default.cd(path_1.default.join(__dirname, ".."));
    // 3. parse whisper response string into array
    const transcriptArray = parseTranscript(transcript);
    // Return array
    return transcriptArray;
}
exports.getTranscript = getTranscript;

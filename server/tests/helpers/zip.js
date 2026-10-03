import fs from 'node:fs';
import {inflateRawSync} from 'node:zlib';

// Read a shipped source file from the ZIP's central directory (no external tools).
export function readArchiveFile(archivePath, basename) {
    const data = fs.readFileSync(archivePath);
    let end = data.length - 22;
    while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0) throw new Error('ZIP central directory not found');
    let offset = data.readUInt32LE(end + 16);
    const count = data.readUInt16LE(end + 10);
    for (let index = 0; index < count; index++) {
        if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry');
        const method = data.readUInt16LE(offset + 10);
        const length = data.readUInt32LE(offset + 20);
        const nameLength = data.readUInt16LE(offset + 28);
        const extraLength = data.readUInt16LE(offset + 30);
        const commentLength = data.readUInt16LE(offset + 32);
        const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        if (name.split('/').at(-1) === basename) {
            const local = data.readUInt32LE(offset + 42);
            const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
            const compressed = data.subarray(start, start + length);
            if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression');
            return (method === 8 ? inflateRawSync(compressed) : compressed).toString('utf8');
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    throw new Error(`${basename} not found in archive`);
}

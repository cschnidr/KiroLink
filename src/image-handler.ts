/**
 * Download Telegram photos to disk so Kiro CLI can access them via the
 * `read` tool. Photos are saved to a configurable directory and cleaned
 * up based on a max-age policy.
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

export interface ImageHandlerOptions {
  imageDir: string;
  maxAgeHours: number;
}

/**
 * Ensure the image directory exists.
 */
export function ensureImageDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Download a file from a URL to a local path.
 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    mod.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      reject(err);
    });
  });
}

/**
 * Download a Telegram photo and save it to the image directory.
 * Returns the absolute path to the saved file.
 */
export async function savePhoto(
  fileUrl: string,
  fileId: string,
  imageDir: string,
): Promise<string> {
  ensureImageDir(imageDir);
  const ext = path.extname(fileUrl) || ".jpg";
  const filename = `${Date.now()}-${fileId.slice(0, 16)}${ext}`;
  const dest = path.join(imageDir, filename);
  await downloadFile(fileUrl, dest);
  return dest;
}

/**
 * Delete images older than maxAgeHours. Runs best-effort (errors logged, not thrown).
 */
export function cleanupOldImages(imageDir: string, maxAgeHours: number): void {
  if (maxAgeHours <= 0) return;
  if (!fs.existsSync(imageDir)) return;

  const cutoff = Date.now() - maxAgeHours * 3600_000;
  try {
    for (const entry of fs.readdirSync(imageDir)) {
      const filePath = path.join(imageDir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // skip individual file errors
      }
    }
  } catch (err) {
    console.log(JSON.stringify({ level: "warn", msg: "image cleanup failed", err: String(err) }));
  }
}

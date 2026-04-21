const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const postsDir = path.join(projectRoot, "source", "_posts");
const mediaRoot = path.join(projectRoot, "source", "uploads", "wordpress-media");
const manifestPath = path.join(projectRoot, "source", "uploads", "wordpress-media", "manifest.json");

const MEDIA_EXT_RE = /\.(jpg|jpeg|png|gif|webp|svg|avif|mp4|webm|mov)$/i;
const URL_RE = /https?:\/\/[^\s"')>]+/g;

function listMarkdownFiles(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(dir, name));
}

function sanitizeSegment(segment) {
  return segment.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

function buildLocalRelativePath(urlString) {
  const url = new URL(urlString);
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));
  return path.posix.join("uploads", "wordpress-media", sanitizeSegment(url.host), ...segments);
}

function collectMediaUrls(text) {
  const urls = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    try {
      const pathname = new URL(url).pathname;
      if (MEDIA_EXT_RE.test(pathname)) {
        urls.push(url);
      }
    } catch {
      // Ignore malformed URLs.
    }
  }
  return urls;
}

async function downloadFile(url, destinationPath) {
  const candidates = buildCandidateUrls(url);
  let lastError = null;
  const expectedKind = mediaKindFromPath(new URL(url).pathname);

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { redirect: "follow" });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} for ${candidate}`);
        continue;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!looksLikeExpectedMedia(contentType, expectedKind)) {
        lastError = new Error(`Unexpected content-type ${contentType || "unknown"} for ${candidate}`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, Buffer.from(arrayBuffer));
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Unable to download ${url}`);
}

function mediaKindFromPath(pathname) {
  if (/\.(mp4|webm|mov)$/i.test(pathname)) {
    return "video";
  }
  return "image";
}

function looksLikeExpectedMedia(contentType, expectedKind) {
  if (!contentType) {
    return false;
  }
  if (expectedKind === "video") {
    return contentType.startsWith("video/");
  }
  return contentType.startsWith("image/");
}

function buildCandidateUrls(urlString) {
  const candidates = new Set([urlString]);
  const url = new URL(urlString);
  const pathname = url.pathname;
  const strippedPath = pathname.replace(/-\d+x\d+(?=\.[^.]+$)/i, "");
  const hostFallbacks = [];

  if (url.host === "www.zhangyanwen.cn") {
    hostFallbacks.push("http://www.yanwen.great-site.net");
  }

  if (strippedPath !== pathname) {
    candidates.add(new URL(strippedPath, url.origin).toString());
  }

  if (url.protocol === "http:") {
    const httpsUrl = new URL(urlString);
    httpsUrl.protocol = "https:";
    candidates.add(httpsUrl.toString());

    if (strippedPath !== pathname) {
      candidates.add(new URL(strippedPath, httpsUrl.origin).toString());
    }
  }

  if (url.protocol === "https:") {
    const httpUrl = new URL(urlString);
    httpUrl.protocol = "http:";
    candidates.add(httpUrl.toString());

    if (strippedPath !== pathname) {
      candidates.add(new URL(strippedPath, httpUrl.origin).toString());
    }
  }

  for (const origin of hostFallbacks) {
    candidates.add(new URL(pathname, origin).toString());
    if (strippedPath !== pathname) {
      candidates.add(new URL(strippedPath, origin).toString());
    }
  }

  return [...candidates];
}

async function main() {
  const files = listMarkdownFiles(postsDir);
  const replacements = new Map();
  const touchedFiles = [];
  const failures = [];

  for (const filePath of files) {
    const text = fs.readFileSync(filePath, "utf8");
    const mediaUrls = collectMediaUrls(text);
    for (const url of mediaUrls) {
      if (!replacements.has(url)) {
        const relativePath = buildLocalRelativePath(url);
        replacements.set(url, {
          localUrl: `/${relativePath.replace(/\\/g, "/")}`,
          relativePath
        });
      }
    }
  }

  const downloads = [];
  for (const [url, info] of replacements.entries()) {
    const destinationPath = path.join(projectRoot, "source", info.relativePath);
    if (!fs.existsSync(destinationPath)) {
      try {
        await downloadFile(url, destinationPath);
        downloads.push(info.relativePath);
      } catch (error) {
        failures.push({ url, error: error.message });
      }
    }
  }

  const successfulReplacements = new Map(
    [...replacements.entries()].filter(([, info]) =>
      fs.existsSync(path.join(projectRoot, "source", info.relativePath))
    )
  );

  for (const filePath of files) {
    const originalText = fs.readFileSync(filePath, "utf8");
    let nextText = originalText;
    let changed = false;
    for (const [url, info] of successfulReplacements.entries()) {
      if (nextText.includes(url)) {
        nextText = nextText.split(url).join(info.localUrl);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(filePath, nextText, "utf8");
      touchedFiles.push(path.basename(filePath));
    }
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mediaCount: replacements.size,
        localizedMediaCount: successfulReplacements.size,
        downloadedCount: downloads.length,
        failures,
        mappings: Object.fromEntries(
          [...successfulReplacements.entries()].map(([url, info]) => [url, info.localUrl])
        )
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        markdownFiles: files.length,
        discoveredMediaCount: replacements.size,
        localizedMediaCount: successfulReplacements.size,
        downloadedCount: downloads.length,
        failedCount: failures.length,
        touchedFilesCount: touchedFiles.length,
        failedUrlsSample: failures.slice(0, 10),
        sampleDownloads: downloads.slice(0, 10)
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
}

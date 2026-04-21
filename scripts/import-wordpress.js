const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "source", "_posts");

function getFirstMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : "";
}

function decodeCdata(value) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&");
}

function readText(text, tagName) {
  const raw = getFirstMatch(text, new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
  if (!raw) {
    return "";
  }
  if (raw.startsWith("<![CDATA[")) {
    return decodeCdata(raw);
  }
  return decodeXmlEntities(raw);
}

function readWpText(text, tagName) {
  return getFirstMatch(
    text,
    new RegExp(`<wp:${tagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></wp:${tagName}>`)
  );
}

function readContent(text) {
  return getFirstMatch(
    text,
    /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/
  );
}

function readTerms(text, domain) {
  const pattern = new RegExp(
    `<category domain="${domain}" nicename="([^"]*)">([\\s\\S]*?)</category>`,
    "g"
  );
  const values = [];
  for (const match of text.matchAll(pattern)) {
    const nicename = match[1].trim();
    const label = decodeXmlEntities(
      match[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()
    );
    values.push(label || nicename);
  }
  return [...new Set(values.filter(Boolean))];
}

function decodeSlug(slug, fallback) {
  if (!slug) {
    return fallback;
  }
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

function cleanBody(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const withoutBlockComments = normalized
    .replace(/<!--\s+wp:[\s\S]*?-->\n?/g, "")
    .replace(/<!--\s+\/wp:[\s\S]*?-->\n?/g, "");
  return withoutBlockComments.trim() + "\n";
}

function yamlValue(value) {
  return JSON.stringify(value ?? "");
}

function yamlList(name, values) {
  if (!values.length) {
    return `${name}: []`;
  }
  return [ `${name}:`, ...values.map((value) => `  - ${yamlValue(value)}`) ].join("\n");
}

function makeAsciiFilename(dateValue, postId) {
  const datePart = dateValue ? dateValue.slice(0, 10) : "1970-01-01";
  return `${datePart}-post-${postId}.md`;
}

function buildPermalink(dateValue, slug) {
  const datePart = dateValue ? dateValue.slice(0, 10) : "1970-01-01";
  const [year, month, day] = datePart.split("-");
  return `${year}/${month}/${day}/${slug}/`;
}

function importWordPress(inputPath) {
  if (!inputPath) {
    console.error("Usage: node scripts/import-wordpress.js <wordpress-export.xml>");
    process.exit(1);
  }

  const xml = fs.readFileSync(inputPath, "utf8");
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1]);
  const imported = [];

  for (const item of items) {
    const postType = readWpText(item, "post_type");
    const status = readWpText(item, "status");

    if (postType !== "post" || status !== "publish") {
      continue;
    }

    const title = readText(item, "title") || "Untitled";
    const postId = readWpText(item, "post_id") || String(imported.length + 1);
    const date = readWpText(item, "post_date") || readText(item, "pubDate");
    const updated = readWpText(item, "post_modified") || date;
    const slug = decodeSlug(readWpText(item, "post_name"), `post-${postId}`);
    const author = readText(item, "dc:creator");
    const categories = readTerms(item, "category");
    const tags = readTerms(item, "post_tag");
    const content = cleanBody(readContent(item));
    const permalink = buildPermalink(date, slug);

    const frontMatter = [
      "---",
      `title: ${yamlValue(title)}`,
      `date: ${yamlValue(date)}`,
      `updated: ${yamlValue(updated)}`,
      `author: ${yamlValue(author)}`,
      `slug: ${yamlValue(slug)}`,
      ...(permalink ? [`permalink: ${yamlValue(permalink)}`] : []),
      yamlList("categories", categories),
      yamlList("tags", tags),
      "---",
      ""
    ].join("\n");

    const filename = makeAsciiFilename(date, postId);
    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, `${frontMatter}\n${content}`, "utf8");

    imported.push({
      filename,
      title,
      date
    });
  }

  console.log(
    JSON.stringify(
      {
        importedCount: imported.length,
        files: imported.slice(0, 10)
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  importWordPress(process.argv[2]);
}

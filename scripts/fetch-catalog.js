#!/usr/bin/env node
/**
 * Pulls ALTO catalog data from Airtable and writes a static JSON file
 * (plus locally-hosted photos) for the GitHub Pages catalog site.
 *
 * Airtable attachment URLs returned by the API expire after ~2 hours,
 * so Profile Photos are downloaded and committed as local files rather
 * than referenced by the transient Airtable URL.
 *
 * Gate logic:
 *   - Teaching Artist shown only if Current ALTO LOA = true
 *   - Residency shown only if Available = true AND its linked
 *     Teaching Artist passes the LOA gate above
 *   - TA Approved and Fully Cleared are intentionally NOT used as gates
 */

import fs from "node:fs/promises";
import path from "node:path";

const BASE_ID = "appvIZeFTshTXHIBt";
const TEACHING_ARTISTS_TABLE = "tblLu2dKhHjWVzOuJ";
const RESIDENCIES_TABLE = "tblDvgUdMRl5QUuZb";

const TOKEN = process.env.AIRTABLE_TOKEN;
if (!TOKEN) {
  console.error("Missing AIRTABLE_TOKEN environment variable.");
  process.exit(1);
}

const API_ROOT = "https://api.airtable.com/v0";
const OUTPUT_DIR = path.join(process.cwd(), "data");
const PHOTOS_DIR = path.join(OUTPUT_DIR, "photos");

async function airtableList(tableId, { filterByFormula, fields } = {}) {
  const records = [];
  let offset;
  do {
    const url = new URL(`${API_ROOT}/${BASE_ID}/${tableId}`);
    if (filterByFormula) url.searchParams.set("filterByFormula", filterByFormula);
    if (fields) fields.forEach((f) => url.searchParams.append("fields[]", f));
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(
        `Airtable API error (${tableId}): ${res.status} ${await res.text()}`
      );
    }
    const json = await res.json();
    records.push(...json.records);
    offset = json.offset;
  } while (offset);
  return records;
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function downloadPhoto(url, destBasename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download photo: ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  const ext = contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
    ? "webp"
    : "jpg";
  const filename = `${destBasename}.${ext}`;
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(path.join(PHOTOS_DIR, filename), buffer);
  return `photos/${filename}`;
}

async function main() {
  await fs.mkdir(PHOTOS_DIR, { recursive: true });

  // 1. Qualified teaching artists: must have a current Letter of Agreement.
  const artistRecords = await airtableList(TEACHING_ARTISTS_TABLE, {
    filterByFormula: "{Current ALTO LOA} = TRUE()",
    fields: ["Name", "Main Art Form", "Biographical Sketch", "Profile Photo"],
  });

  const artistsById = {};
  for (const rec of artistRecords) {
    const f = rec.fields;
    let photoPath = null;
    const photo = f["Profile Photo"]?.[0];
    if (photo) {
      try {
        photoPath = await downloadPhoto(
          photo.url,
          `${slugify(f.Name || rec.id)}-${rec.id.slice(-6)}`
        );
      } catch (err) {
        console.warn(`Photo download failed for ${f.Name}: ${err.message}`);
      }
    }
    artistsById[rec.id] = {
      id: rec.id,
      name: f.Name || "",
      artForm: f["Main Art Form"] || "",
      bio: f["Biographical Sketch"] || "",
      photo: photoPath,
    };
  }

  // 2. Available residencies, only if their linked TA is qualified above.
  const residencyRecords = await airtableList(RESIDENCIES_TABLE, {
    filterByFormula: "{Available} = TRUE()",
    fields: [
      "Residency Title",
      "NEW!",
      "Description",
      "Teaching Artist",
      "Target Grade Level",
      "Art Form(s)",
      "Connected Curriculum Area(s)",
      "Number of Sessions",
      "Anchor ID",
    ],
  });

  const residencies = [];
  for (const rec of residencyRecords) {
    const f = rec.fields;
    const taId = f["Teaching Artist"]?.[0];
    const artist = taId ? artistsById[taId] : null;
    if (!artist) continue; // linked TA doesn't currently have an LOA — hide residency

    residencies.push({
      id: rec.id,
      title: f["Residency Title"] || "",
      isNew: !!f["NEW!"],
      description: f.Description || "",
      teachingArtist: { id: artist.id, name: artist.name },
      gradeLevel: f["Target Grade Level"] || "",
      artForms: f["Art Form(s)"] || [],
      curriculumAreas: f["Connected Curriculum Area(s)"] || [],
      sessions: f["Number of Sessions"] ?? null,
      anchorId: f["Anchor ID"] || "",
    });
  }

  // Only surface artist bios for artists tied to a currently visible residency.
  const usedArtistIds = new Set(residencies.map((r) => r.teachingArtist.id));
  const artists = Object.values(artistsById).filter((a) =>
    usedArtistIds.has(a.id)
  );

  const output = {
    generatedAt: new Date().toISOString(),
    artists,
    residencies,
  };

  await fs.writeFile(
    path.join(OUTPUT_DIR, "catalog.json"),
    JSON.stringify(output, null, 2)
  );

  console.log(
    `Wrote ${residencies.length} residencies and ${artists.length} artists.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

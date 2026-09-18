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
 *   - Residency shown only if Available = true
 *   - A residency must have at least one linked Teaching Artist
 *     with a Current ALTO LOA to appear in the catalog
 *   - If some linked artists do not have a Current ALTO LOA,
 *     those artists are omitted but the residency remains visible
 *     as long as at least one qualified artist remains
 *   - TA Approved and Fully Cleared are intentionally NOT used as gates
 *
 * Artist Assignment values from Airtable:
 *   - Solo
 *   - Co-led
 *   - Variable
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

    if (filterByFormula) {
      url.searchParams.set("filterByFormula", filterByFormula);
    }

    if (fields) {
      fields.forEach((f) => url.searchParams.append("fields[]", f));
    }

    if (offset) {
      url.searchParams.set("offset", offset);
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
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

  if (!res.ok) {
    throw new Error(`Failed to download photo: ${res.status}`);
  }

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

  // ------------------------------------------------------------
  // 1. Teaching Artists
  // Only artists with a Current ALTO LOA are eligible to appear.
  // ------------------------------------------------------------

  const artistRecords = await airtableList(TEACHING_ARTISTS_TABLE, {
    filterByFormula: "{Current ALTO LOA} = TRUE()",
    fields: [
      "Name",
      "Main Art Form",
      "Biographical Sketch",
      "Profile Photo",
    ],
  });

  console.log(
    `Fetched ${artistRecords.length} teaching artists with Current ALTO LOA.`
  );

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
        console.warn(
          `Photo download failed for ${f.Name || rec.id}: ${err.message}`
        );
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

  // ------------------------------------------------------------
  // 2. Available Residencies
  // Airtable's Available checkbox is authoritative.
  // ------------------------------------------------------------

  const residencyRecords = await airtableList(RESIDENCIES_TABLE, {
    filterByFormula: "{Available} = TRUE()",
    fields: [
      "Residency Title",
      "NEW!",
      "Description",
      "Teaching Artist",
      "Artist Assignment",
      "Target Grade Level",
      "Art Form(s)",
      "Connected Curriculum Area(s)",
      "Sessions",
      "Notes",
      "Anchor ID",
    ],
  });

  console.log(
    `Fetched ${residencyRecords.length} Available residency records from Airtable.`
  );

  console.log("Residencies returned by Airtable:");

  for (const rec of residencyRecords) {
    console.log(
      `- ${rec.fields["Residency Title"] || "(untitled)"} [${rec.id}]`
    );
  }

  const residencies = [];

  for (const rec of residencyRecords) {
    const f = rec.fields;
    const title = f["Residency Title"] || "(untitled)";

    const taIds = f["Teaching Artist"] || [];

    // An Available residency still needs at least one linked TA.
    if (!taIds.length) {
      console.warn(
        `SKIPPED: "${title}" — no Teaching Artist linked in Airtable.`
      );
      continue;
    }

    // Keep only linked artists who passed the Current ALTO LOA query.
    const qualifiedArtists = taIds
      .map((id) => artistsById[id])
      .filter(Boolean);

    // If no linked artist currently qualifies, there is nobody who
    // can actually deliver the residency, so it cannot be displayed.
    if (!qualifiedArtists.length) {
      console.warn(
        `SKIPPED: "${title}" — none of its linked Teaching Artists currently have a Current ALTO LOA.`
      );
      continue;
    }

    // Report omitted linked artists for diagnostic purposes, but do
    // NOT suppress the residency if at least one qualified artist remains.
    if (qualifiedArtists.length < taIds.length) {
      const omittedIds = taIds.filter((id) => !artistsById[id]);

      console.warn(
        `NOTICE: "${title}" — ${omittedIds.length} linked Teaching Artist(s) omitted because they do not currently have a Current ALTO LOA: ${omittedIds.join(
          ", "
        )}`
      );
    }

    const teachingArtists = qualifiedArtists.map((artist) => ({
      id: artist.id,
      name: artist.name,
    }));

    residencies.push({
      id: rec.id,
      title: f["Residency Title"] || "",
      isNew: !!f["NEW!"],
      description: f.Description || "",

      // TEMPORARY backward compatibility with the current catalog page.
      // The existing page expects one teachingArtist object.
      teachingArtist: teachingArtists[0],

      // New multi-artist structure.
      teachingArtists,

      artistAssignment: f["Artist Assignment"] || "Solo",

      gradeLevel: f["Target Grade Level"] || "",
      artForms: f["Art Form(s)"] || [],
      curriculumAreas: f["Connected Curriculum Area(s)"] || [],
      sessions: f["Sessions"] ?? null,

      // Optional field. The catalog page will display this only
      // when the field actually contains text.
      notes: f["Notes"] || "",

      anchorId: f["Anchor ID"] || "",
    });
  }

  // ------------------------------------------------------------
  // 3. Artist Bios
  // Only include artists associated with currently visible residencies.
  // ------------------------------------------------------------

  const usedArtistIds = new Set(
    residencies.flatMap((residency) =>
      residency.teachingArtists.map((artist) => artist.id)
    )
  );

  const artists = Object.values(artistsById).filter((artist) =>
    usedArtistIds.has(artist.id)
  );

  // ------------------------------------------------------------
  // 4. Write catalog.json
  // ------------------------------------------------------------

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

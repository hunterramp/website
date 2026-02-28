import fs from "node:fs/promises";

function sanitizeSecret(value) {
  if (!value) {
    return "";
  }

  return value.trim().replace(/^['"]|['"]$/g, "");
}

const SPOTIFY_CLIENT_ID = sanitizeSecret(process.env.SPOTIFY_CLIENT_ID);
const SPOTIFY_CLIENT_SECRET = sanitizeSecret(process.env.SPOTIFY_CLIENT_SECRET);
const SPOTIFY_REFRESH_TOKEN = sanitizeSecret(process.env.SPOTIFY_REFRESH_TOKEN);

const OUTPUT_PATH = "data/spotify-now-playing.json";

async function readExistingPayload() {
  try {
    const raw = await fs.readFile(OUTPUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function comparablePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const clone = { ...payload };
  delete clone.updatedAt;
  return clone;
}

function hasMeaningfulChange(previous, next) {
  return JSON.stringify(comparablePayload(previous)) !== JSON.stringify(comparablePayload(next));
}

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

function toTrack(track) {
  if (!track) {
    return null;
  }

  const artists = Array.isArray(track.artists) ? track.artists.map((a) => a.name) : [];
  const imageUrl = track.album?.images?.[0]?.url ?? null;

  return {
    name: track.name ?? null,
    artists,
    album: track.album?.name ?? null,
    imageUrl,
    spotifyUrl: track.external_urls?.spotify ?? null
  };
}

async function getAccessToken() {
  required("SPOTIFY_CLIENT_ID", SPOTIFY_CLIENT_ID);
  required("SPOTIFY_REFRESH_TOKEN", SPOTIFY_REFRESH_TOKEN);

  const baseBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: SPOTIFY_REFRESH_TOKEN
  });

  async function requestToken(body, headers) {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers,
      body: body.toString()
    });

    if (!response.ok) {
      let detail = "";
      try {
        const errorBody = await response.json();
        if (errorBody?.error) {
          detail = errorBody.error;
        }
        if (errorBody?.error_description) {
          detail += detail ? ` - ${errorBody.error_description}` : errorBody.error_description;
        }
      } catch {
        detail = "";
      }

      throw new Error(`Token request failed: ${response.status}${detail ? ` (${detail})` : ""}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error("Token response did not include access_token");
    }

    return data.access_token;
  }

  if (SPOTIFY_CLIENT_SECRET) {
    const basicAuth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
    try {
      return await requestToken(baseBody, {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("invalid_grant")) {
        throw error;
      }
    }
  }

  const pkceBody = new URLSearchParams(baseBody);
  pkceBody.set("client_id", SPOTIFY_CLIENT_ID);
  return requestToken(pkceBody, {
    "Content-Type": "application/x-www-form-urlencoded"
  });
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Spotify API request failed: ${response.status}`);
  }

  return response.json();
}

async function getListeningPayload() {
  const token = await getAccessToken();
  const updatedAt = new Date().toISOString();

  const current = await fetchJson("https://api.spotify.com/v1/me/player/currently-playing", token);
  if (current?.item) {
    return {
      updatedAt,
      isPlaying: Boolean(current.is_playing),
      source: "currently-playing",
      track: toTrack(current.item)
    };
  }

  const recent = await fetchJson("https://api.spotify.com/v1/me/player/recently-played?limit=1", token);
  const recentTrack = recent?.items?.[0]?.track;
  if (recentTrack) {
    return {
      updatedAt,
      isPlaying: false,
      source: "recently-played",
      track: toTrack(recentTrack)
    };
  }

  return {
    updatedAt,
    isPlaying: false,
    source: "none",
    track: null
  };
}

async function main() {
  let payload;
  const existing = await readExistingPayload();

  try {
    payload = await getListeningPayload();
  } catch (error) {
    payload = {
      updatedAt: new Date().toISOString(),
      isPlaying: false,
      source: "error",
      track: existing?.track ?? null,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }

  if (existing && !hasMeaningfulChange(existing, payload)) {
    return;
  }

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

main();

# Nearest Town API

Returns the US town a latitude/longitude is in, or the nearest one if it's in no town:

1. If the point is **inside a town's boundary**, that town is returned. For example, Great American Ballpark gives Cincinnati, OH, even though Newport, KY's center point is closer.
2. Otherwise, the town with the **nearest center point** is returned. This is how the NWS `/points` API worked before late June 2026.

Distance and direction are always measured from the town's center point.

There are no dependencies: plain Node (20 or newer) and two data files in `data/`.

## Data

`data/places.json` is built from the [Census Gazetteer "Places" file](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html), currently the 2025 vintage, with about 32,000 places. NWS uses this same list. It includes:

- incorporated places (cities, towns, villages, boroughs)
- Census Designated Places (unincorporated communities)
- Puerto Rico *zonas urbanas* and *comunidades*

Each place's center is the Census **internal point**: roughly the middle of the place's land area, not necessarily its downtown.

`data/boundaries.bin.gz` holds each place's boundary from the Census [cartographic boundary file](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html) `cb_2025_us_place_500k` (simplified to 1:500,000 scale, about 1.9 million points). Points within a few meters of a town line can land on either side.

Names have their type suffix removed ("Millhousen town" → "Millhousen"). Consolidated city-counties get their common names ("Nashville-Davidson metropolitan government (balance)" → "Nashville"); see `OVERRIDES` in `build-data.mjs`.

To rebuild when the Census publishes a new vintage (needs `unzip`), use the same year for both files so the IDs match:

```sh
node build-data.mjs 2026 && node build-boundaries.mjs 2026
```

## Run

```sh
node server.mjs                 # listens on 127.0.0.1:8080
PORT=3000 node server.mjs
npm test
```

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `127.0.0.1` | Only reachable from this machine. Use `0.0.0.0` to accept outside connections (the Dockerfile does this inside the container). |
| `RATE_LIMIT_PER_MIN` | `600` | Requests per client IP per minute to `/nearest`; `0` turns it off. |
| `TRUST_PROXY` | off | Set to `1` **only** behind your own reverse proxy, so rate limiting uses the real client IP from `X-Forwarded-For`. Without a proxy, clients could fake that header to dodge the limit. |

### Deploy

Put it behind a reverse proxy (Caddy, nginx, etc.) that handles HTTPS, and set `TRUST_PROXY=1`.

- **systemd:** `nearest-town-api.service` runs the server as a throwaway user with no write access, no privileges and a restricted set of system calls. Check it with `systemd-analyze security nearest-town-api`.
- **Docker:**
  ```sh
  docker build -t nearest-town-api .
  docker run -d --restart unless-stopped --read-only --cap-drop ALL \
    --security-opt no-new-privileges -p 127.0.0.1:8080:8080 nearest-town-api
  ```

## Security

- **No dependencies:** only Node's standard library, so there are no third-party packages to compromise.
- **Strict input checking:** coordinates must be plain decimal degrees within range. URLs are never decoded, so malformed escapes can't break anything.
- **No crash on a bad request:** unexpected errors return a generic `500`. The details are logged on the server, never sent to the client.
- **Slow clients dropped:** headers must arrive within 10 s and the whole request within 15 s. Headers are capped at 8 KB.
- **Rate limit:** per IP, in memory (resets when the server restarts). For several servers or more control, rate-limit at the reverse proxy instead.
- **Response headers:** `nosniff`, a deny-all Content-Security-Policy, `no-referrer`. CORS allows any site, which is intended for a public read-only API.
- **Least privilege:** the server stores nothing, reads only its data files and never writes to disk.

## API

`GET /nearest/{lat},{lon}`, or `GET /nearest?lat={lat}&lon={lon}`

```json
{
  "query": { "lat": 39.237535, "lon": -85.461877 },
  "town": { "name": "Millhousen", "state": "IN", "type": "town", "geoid": "1849662", "lat": 39.211988, "lon": -85.434165 },
  "inside": false,
  "distance": { "meters": 3711, "miles": 2.31 },
  "bearing": 320,
  "direction": "NW",
  "text": "2.3 miles NW of Millhousen, IN"
}
```

- `inside` is `true` when the point is within the town's boundary. `distance`, `bearing`, `direction` and `text` are always measured from the town's center, even inside it (`"3.0 miles S of Cincinnati, OH"`).
- The center is the middle of the town's land area, which can be far from downtown in big or merged city-counties. Downtown Anchorage is about 20 miles W of the Municipality of Anchorage's center.
- `bearing` / `direction` are measured **from the town center to the query point**, as in "2.3 miles NW of Millhousen".
- Invalid coordinates return `400`.
- `GET /health` returns the status and which data file is loaded.
- Responses include `Access-Control-Allow-Origin: *` so browsers can call the API directly.
- There's no coverage limit: a point in Canada or the ocean still gets the nearest US place.

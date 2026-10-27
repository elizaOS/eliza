# Eliza Cloud Maps backends

Eliza Cloud Maps (`/api/v1/maps/*`, see `packages/cloud/api/README.md`) is a
provider-neutral gateway. It authenticates the account, checks the
subscription and the separate Maps request allowance, then asks one configured
provider. This directory is the reference self-hostable provider: OpenStreetMap
data in Nominatim (search, geocode, reverse geocode, place details) and
GraphHopper (drive, walk and bicycle routes with alternatives), behind Caddy.

## Provider seam

`packages/cloud/shared/src/lib/services/maps/provider-registry.ts` chooses the
provider from settings. No route code changes are needed to switch:

| Setting | Values |
| --- | --- |
| `ELIZA_MAPS_PROVIDER` | `osm` (default), `none`, or a kind added with `registerMapsProvider` |
| `ELIZA_MAPS_GEOCODER` | `nominatim` (default; any Nominatim-compatible API), or `registerMapsGeocoder` |
| `ELIZA_MAPS_ROUTER` | `graphhopper` (default), `valhalla`, or `registerMapsRouter` |
| `ELIZA_MAPS_ROUTER_PROFILES` | JSON mode → profile or costing; modes left out are not offered |
| `ELIZA_MAPS_ATTRIBUTION` | Overrides the composed credit, e.g. a hosted service's required text |
| `ELIZA_MAPS_OPERATOR` | Who runs the backends; shown in the location disclosure |
| `ELIZA_MAPS_PROVIDER_ID` | Provider identity reported to clients (default `eliza-cloud-osm`) |

The endpoint, coverage and revision settings are unchanged
(`ELIZA_MAPS_GEOCODER_URL`, `ELIZA_MAPS_ROUTER_URL`, their `_API_KEY`s,
`ELIZA_MAPS_COVERAGE_JSON`, `ELIZA_MAPS_DATASET_REVISION`,
`ELIZA_MAPS_ROUTE_ALTERNATIVES`). Without them Maps reports
`503 maps_not_configured`; an invalid value is reported the same way and its
value is never logged. A commercial provider is added as a new provider or
backend kind with its own attribution, not by mixing its results into another
provider's map.

`GET /api/v1/maps/capabilities` reports `sources` (data, search and routing
services) and `disclosure`: every service that receives a request's text and
coordinates, who operates it, and that Cloud keeps only the operation and its
result code. Clients show this near search and location controls.

## Running the reference stack

Prerequisites: Docker Compose, two DNS names pointing at the host, and enough
memory for the region (a city or small country fits in a few GB).

1. Choose the region and extract (for example a Geofabrik `.osm.pbf`). Save it
   as `data/region.osm.pbf` and set `MAPS_PBF_URL` to the same file.
2. Download `graphhopper-web-10.2.jar` from Maven Central once, review it and
   record its SHA-256 in `GRAPHHOPPER_SHA256`. The image build refuses a
   different jar.
3. `cp maps.env.example .env`, fill in every value, then
   `docker compose up -d --build`. Nominatim imports the extract on first
   start; GraphHopper builds its graph on first start.
4. Set the Cloud settings listed at the end of `maps.env.example`. The
   coverage bounds must lie inside the extract. Use the extract date as
   `ELIZA_MAPS_DATASET_REVISION`.
5. Check: `GET /api/v1/maps/capabilities` with an entitled account returns
   the regions and modes; a search and a route inside the region return
   attributed results; a point outside returns `422 unsupported_region`.

## Privacy

Queries and coordinates reach only Cloud and these two backends. Cloud logs
operation and code only. Caddy has no access log, GraphHopper's request log is
disabled in `graphhopper/config.yml`, and the access key is stripped before a
request reaches a backend. Nominatim's image runs its own web server: after
the first search, confirm with `docker compose logs nominatim` and the
container's web-server log files that no request line with the query text is
written, and disable that log if it is. Keep host-level proxies and load
balancers from logging query strings.

## Data, licences and operations

- OpenStreetMap data is ODbL. Keep the attribution that Cloud returns visible
  wherever results appear, and meet the share-alike terms for any derived
  database you publish.
- Nominatim (GPL-2.0) and GraphHopper (Apache-2.0) run unmodified as network
  services.
- Updates: re-import or replicate, rebuild the GraphHopper graph from the same
  extract, then change `ELIZA_MAPS_DATASET_REVISION`. Clients treat a new
  revision as a new dataset.
- Transit schedules, live traffic, map tiles and offline data are not served.

## Steps that need the operator

- Choose and license the production provider and region coverage (Alpha
  decision A-23); the reference stack is one option, not the decision.
- Provision hosts, DNS, TLS, capacity, monitoring and the update schedule.
- Review and record the GraphHopper jar digest.
- Set the Cloud settings and the Maps request allowance
  (`ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES`) per environment.

# Website reputation

Eliza Cloud keeps an index of known harmful websites. The index comes from
public threat lists. Cloud uses it in two places:

- Hosted web search marks results that are on a threat list.
- `POST /api/v1/website-reputation/lookup` lets a client check a website
  without sending the website address to Cloud.

## Results

A check gives one of three results:

| Result | Meaning |
| --- | --- |
| `listed` | A loaded threat list contains the host or a parent domain. The result names the list and the category. |
| `not_listed` | At least one list has loaded and no loaded list contains the host. Show this as "No known threat". |
| `unavailable` | No list has ever loaded, the index is missing or corrupt, or the address cannot be checked. |

No result means "safe". Do not show `not_listed` as safe.

On a device, the local threat list is the primary check. The Cloud check only
adds information. A browser must not wait for the Cloud check before it opens
a page. Only a confirmed `listed` result can stop navigation.

## Threat lists

Only threat lists are used. HaGeZi ad and tracker lists (multi, pro, ultimate)
are not used, because they block ordinary sites.

| ID | Source | URL | License | Review state |
| --- | --- | --- | --- | --- |
| `phishing-database` | Phishing.Database | `https://phish.co.za/latest/phishing-domains-ACTIVE.txt` (fallback: GitHub repository at the latest commit of the file) | MIT | `verified` |
| `hagezi-tif-medium` | HaGeZi Threat Intelligence Feeds, medium | `https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt` | GPL-3.0 (compilation) | `approved` |
| `hagezi-fake` | HaGeZi Fake | `https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/fake-onlydomains.txt` | GPL-3.0 (compilation) | `approved` |

The list selection is `WEBSITE_THREAT_FEEDS` in
`src/lib/services/website-reputation.ts`. The device uses HaGeZi TIF mini;
Cloud uses TIF medium (about 660,000 entries) for more coverage.

For each list, every run records the source URL, license, fetch time,
publication time and SHA-256 of the list body in
`website-reputation/v1/manifest.json`. The last-good body is kept at
`website-reputation/v1/lists/<id>.txt` with the same metadata.

### License reasoning

- Phishing.Database is MIT. Use and redistribution are permitted with the
  notice. Cloud stores the list and serves hash matches.
- The HaGeZi compilation is GPL-3.0. GPL-3.0 conditions apply when a work is
  conveyed (distributed). A server-side lookup does not convey the list.
  GPL-3.0 has no network-use clause (AGPL-3.0 has one). The lookup response
  contains only SHA-256 hashes of matching entries, not the list.
- HaGeZi states that its sources keep their own terms and that GPL-3.0 grants
  no rights in that third-party data. The owner consulted counsel, who said
  that the use of the HaGeZi lists is acceptable. The lookup APIs are free and
  open, part of the open-source stack, and not sold. Review state:
  `approved` (owner and counsel, 2026-10-15).
- Removing a list is a one-line change in `WEBSITE_THREAT_FEEDS`.

## Index and storage

The index uses the existing `BLOB` R2 binding. No new cloud resource is needed.

- `website-reputation/v1/manifest.json`: current snapshot and list provenance.
- `website-reputation/v1/slots/<a|b>/<00-ff>.bin`: 256 shards, keyed by the
  first byte of the hash. Each record is a 32-byte SHA-256 of a listed host and
  one byte of list bits. Records are sorted.

A host is listed when the host or a parent domain is on a list (the same rule
as the device). The client hashes the host and its parent domains down to two
labels, with at most six candidates.

## Ingestion

`POST /api/cron/website-reputation-refresh` runs every six hours at minute 45
(`45 */6 * * *`). It has its own schedule because hashing the lists is the
largest CPU step of any cron. It uses `CRON_SECRET`.

For each list the job:

1. Downloads only the fixed URL, with no redirects, a 30-second timeout and a
   size limit (24 MiB for TIF medium and Phishing.Database, 4 MiB for Fake).
2. Checks the format: at least the minimum number of valid hosts, at most 1%
   invalid lines, at most 1,200,000 entries, and for HaGeZi the declared
   "Number of entries". These are the same rules as the device parser.
3. Records the publication time (when the publisher gives one), the fetch
   time and the SHA-256 as provenance. List age is never a reason to reject
   a list.
4. Keeps the last-good list when a download or check fails.

If no list hash changed, the job only updates the manifest. Otherwise it
writes all shards to the inactive slot and then switches the manifest. The
previous snapshot stays in use until the new one is complete. If no list is
usable, the job fails and the previous snapshot stays.

There is no freshness requirement. A list that has loaded is used at any age,
and the last-good copy always counts. Age never changes a result. A host that
is not on a loaded list gives `not_listed` when at least one list has loaded.
The result is `unavailable` only when no list has ever loaded or the index is
missing or corrupt. The same rule applies on the device
(`packages/os/browser/protection`).

## Privacy

The lookup request contains only hash prefixes: the first 4 bytes (default) of
the SHA-256 of each candidate host. Clients can use 2 or 3 bytes for more
privacy. Cloud returns all full hashes on loaded lists that start with a
requested prefix. The client compares full hashes itself.

A prefix is not anonymous. Cloud could compare a prefix with hashes of known
sites. The route requires an API key or session, so Cloud knows which account
made a request. The route does not log prefixes.

Hosted web search checks result URLs on the server directly, because Cloud
already has the search results.

## Client

`@elizaos/cloud-sdk/website-reputation` has the normalization, candidate,
hash and verdict functions, and `createWebsiteReputationClient`. The client
never throws. Any failure gives `unavailable`.

## Operator checks

Before production use:

- Confirm that the Worker can reach `phish.co.za`, `github.com` and
  `raw.githubusercontent.com`.
- Run the cron once in staging and read the manifest. Each list should be
  `refreshed`.
- Watch the cron CPU time and memory. A local run used about 1 second of CPU.
- Phishing.Database: on 2026-10-15 the newest commit of the active list was
  2026-10-02. It is kept and used at that age (owner decision, 2026-10-15).

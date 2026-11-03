# valhalla-app.xyz

The public site is https://valhalla-app.xyz. TokenJunction LLC publishes it. Support is hello@valhalla-app.xyz. This file has no street address and no EIN.

The site files are on the `docs/site` branch. The file `CNAME` in that branch contains `valhalla-app.xyz`. GitHub Pages reads that file and sets the custom domain. The publish workflow also asks GitHub to enforce HTTPS after the certificate exists.

## Namecheap DNS

Open Namecheap, then Domain List, then valhalla-app.xyz, then Advanced DNS. Remove the parking redirect. Remove any old A or CNAME rows for `@` and `www`. Add these rows. TTL can stay Automatic.

| Type | Host | Value |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| AAAA | @ | 2606:50c0:8000::153 |
| AAAA | @ | 2606:50c0:8001::153 |
| AAAA | @ | 2606:50c0:8002::153 |
| AAAA | @ | 2606:50c0:8003::153 |
| CNAME | www | tokenjunction.github.io |

The CNAME target is the GitHub user site host. It is not `tokenjunction.github.io/eliza-valhalla`.

## GitHub Pages

1. Open https://github.com/TokenJunction/eliza-valhalla/settings/pages
2. Set Source to GitHub Actions.
3. Custom domain is `valhalla-app.xyz`. The `CNAME` file sets this on the next publish.
4. After the certificate is issued, turn on Enforce HTTPS. The workflow also sends that request. If the certificate is not ready, GitHub refuses the request and the publish still succeeds.
5. Re-run the workflow named Publish Valhalla site.

The app, the store listing, and the extension use https://valhalla-app.xyz. The privacy policy URL is https://valhalla-app.xyz/privacy-policy.md.

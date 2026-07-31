# Phone model provenance

The landing phone uses a geometry-preserving Meshopt build. The source is the
Blender-exported GLB previously tracked at
`packages/homepage/public/models/iphone.glb`:

- source commit: `4e67d02e8763d496208d852e198ee2528d242934`
- source SHA-256: `c3437ae12307604bbffdb4e283d29b88070fd3b3284c9f55d4efb97e928c07cb`
- built SHA-256: `0dc0921fd45e49e9c03eed4785887bee6bf50bf5449f13c192d87a0b4b6501dd`
- tool: `@gltf-transform/cli@4.4.2`

Reproduce the artifact:

```bash
git show 4e67d02e8763d496208d852e198ee2528d242934:packages/homepage/public/models/iphone.glb > /tmp/iphone-source.glb
bunx @gltf-transform/cli@4.4.2 optimize /tmp/iphone-source.glb packages/homepage/public/models/iphone-meshopt.glb --compress meshopt --flatten false --join false --simplify false --texture-compress false
```

`--simplify false` is deliberate. The main phone keeps all 71,688 source
triangles; only 19 duplicate vertices are welded (54,164 to 54,145). The screen,
island, camera, and flash keep their source triangle counts. Position
quantization has a worst-case half-step of `0.000115` model units on the largest
axis, or `0.000763%` of that axis extent. The package smoke test parses the GLB
and enforces those topology and quantization bounds.

The phone is requested only after the landing viewport is visible and the
browser reaches an idle callback (or the user interacts), so retaining full
geometry does not affect the initial route transfer. Linux screenshots remain
the release baseline; regenerate them only from an exact-head Linux Chromium
run when intended visual changes move the baseline.

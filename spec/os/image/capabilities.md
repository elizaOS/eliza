# Image capabilities

Some native surfaces, such as phone, contacts and SMS in the native
messages bridge, the [dial handoff](../android/phone.md) and the agent's
SMS reply drafting in [telephony review](../../agent/deviceActions/telephonyReview.md),
answer only on an image built for them. The image says so
with a versioned system feature named after the staged launcher package,
`<launcher package>.aosp_image`, written as a product permissions file
beside the staged launcher. Only an image product can put the feature in
the product partition; a sideloaded or standalone install never sees it.
The feature is staging output: only a boot of the built image shows
Android reporting it.

## Story: Advertise only what the image stages

> As a consumer, I want the image to advertise an image-only capability
> exactly for the packages it stages, so that a sideloaded copy of my app
> never claims a surface it cannot have.

### The capability overlay advertises only features of packages the image stages

The overlay declares the image feature for a requested package only when
that package is staged in the image, at the current feature version. A
request for an unstaged package adds nothing.

```quint
pure val imageFeatureVersion = 1
pure def advertisedFeatures(staged: Set[str], requested: Set[str]): Set[str] = requested.intersect(staged)
pure val stagedValues = Set(Set(), Set("com.example.home"), Set("com.example.home", "com.example.listener"))
pure val requestedValues = Set(Set(), Set("com.example.home"), Set("com.example.other"), Set("com.example.home", "com.example.other"))
pure def lawOverlayAdvertisesOnlyStagedPackages(staged: Set[str], requested: Set[str]): bool =
  advertisedFeatures(staged, requested).subseteq(staged) and advertisedFeatures(staged, requested).subseteq(requested)
```

### An image-only surface answers only from a system install that sees a current image feature

A host answers an image-only surface only when it is installed from a
system partition and the image declares its feature at least at the
version the host checks. A sideloaded or standalone install refuses the
surface even if a feature with the same name were present.

```quint
pure def imageSurfaceAvailable(systemInstall: bool, featureDeclared: bool, featureVersion: int): bool =
  systemInstall and featureDeclared and featureVersion >= imageFeatureVersion
pure val featureVersionValues = Set(0, 1, 2)
pure def lawSideloadedHostHasNoImageSurface(featureDeclared: bool, featureVersion: int): bool =
  not(imageSurfaceAvailable(false, featureDeclared, featureVersion))
pure def lawStaleFeatureVersionHasNoSurface(systemInstall: bool, featureDeclared: bool): bool =
  not(imageSurfaceAvailable(systemInstall, featureDeclared, imageFeatureVersion - 1))
```

### SMS reply drafting and the dial handoff are enabled only where the image surface is available

The agent may read and rewrite a reply draft, and a host may advertise
the dial handoff, only on a host that sees a current image feature from a
system install. Drafting never sends: the person sends from the review.

```quint
pure def smsReplyDraftingEnabled(systemInstall: bool, featureDeclared: bool, featureVersion: int): bool =
  imageSurfaceAvailable(systemInstall, featureDeclared, featureVersion)
pure def lawSideloadedHostNeverDraftsReplies(featureDeclared: bool, featureVersion: int): bool =
  not(smsReplyDraftingEnabled(false, featureDeclared, featureVersion))
```

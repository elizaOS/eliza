---
title: Video Gallery
hide_table_of_contents: true
description: A collection of videos showcasing ElizaOS and the ai16z ecosystem
sidebar_position: 8
---

import VideoGallery from '@site/src/components/VideoGallery';

# ElizaOS Video Gallery

Welcome to our video gallery! Here you'll find a collection of demos, tutorials, and community projects related to ElizaOS and the ai16z ecosystem.

<VideoGallery />

---

## Contributing Videos

To add a video to this gallery:

1. Add your video file or YouTube link
2. If not YouTube, make a thumbnail (recommended size: 640x360)
3. Update the `VIDEOS` array in `src/components/VideoGallery/index.jsx`

The video gallery component will automatically handle lazy loading and responsive display.

> `mogrify -path out/ -resize 640x360^ -gravity center -extent 640x360 *.jpg`

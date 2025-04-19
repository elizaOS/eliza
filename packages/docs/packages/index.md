---
sidebar_position: 1
id: index
title: ElizaOS Package Showcase
description: Browse and discover the ecosystem of ElizaOS plugins, clients, and adapters
keywords: [packages, plugins, clients, adapters, showcase, ecosystem, extensions]
hide_title: true
sidebar_label: Showcase
hide_table_of_contents: true
slug: /
image: /img/plugins.jpg
---

import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';

<BrowserOnly>
{() => {
  const ShowcaseComponent = require('@site/src/components/ShowcaseComponent').default;
  return (
    <ShowcaseComponent />
  );
}}
</BrowserOnly>

---
sidebar_position: 1
id: index
title: Showcase
hide_title: true
sidebar_label: Showcase
hide_table_of_contents: true
slug: /
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

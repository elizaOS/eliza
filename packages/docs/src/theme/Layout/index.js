import React from 'react';
import Layout from '@theme-original/Layout';
import AIAssistant from '@site/src/components/AIAssistant';

export default function LayoutWrapper(props) {
  return (
    <>
      <Layout {...props} />
      <AIAssistant />
    </>
  );
}
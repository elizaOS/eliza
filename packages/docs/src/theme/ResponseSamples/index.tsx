import React from 'react';
// @ts-ignore - Docusaurus theme component
import CodeBlock from '@theme/CodeBlock';

interface ResponseSamplesProps {
  responseExample: string;
  language: string;
}

export default function ResponseSamples({ responseExample, language }: ResponseSamplesProps) {
  return (
    <CodeBlock language={language}>
      {responseExample}
    </CodeBlock>
  );
} 
import React from 'react';
import Layout from '@theme/Layout';
import QATestRunner from '../components/QATestRunner';

export default function QATestingPage(): JSX.Element {
  return (
    <Layout
      title="QA Testing Suite"
      description="Comprehensive quality assurance testing for ElizaOS documentation"
    >
      <QATestRunner />
    </Layout>
  );
}

import React from 'react';
import Content from '@theme-original/DocItem/Content';
import CopyPageButton from '@site/src/components/CopyPageButton';
import ContentRecommendations from '@site/src/components/ContentRecommendations';
import AIAssistant from '@site/src/components/AIAssistant';
import styles from './styles.module.css';

export default function ContentWrapper(props) {
  return (
    <>
      <div className={styles.docItemActions}>
        <CopyPageButton />
      </div>
      <Content {...props} />
      <ContentRecommendations />
      <AIAssistant />
    </>
  );
}

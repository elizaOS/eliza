import React from 'react';
import Content from '@theme-original/DocItem/Content';
import CopyPageButton from '@site/src/components/CopyPageButton';
import AIAssistant from '@site/src/components/AIAssistant';
import styles from './styles.module.css';

export default function ContentWrapper(props) {
  return (
    <>
      <div className={styles.docItemActions}>
        <CopyPageButton />
      </div>
      <Content {...props} />
      <AIAssistant />
    </>
  );
}

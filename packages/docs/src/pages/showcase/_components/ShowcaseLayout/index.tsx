// src/pages/showcase/_components/ShowcaseLayout/index.tsx
import React from 'react';
import styles from './styles.module.css';
import { type TagType } from '@site/src/data/users';

export default function ShowcaseLayout({
  children,
  selectedTags,
  toggleTag,
}: {
  children: React.ReactNode;
  selectedTags: TagType[];
  toggleTag: (tag: TagType) => void;
}): JSX.Element {
  return (
    <div className={styles.layout}>
      <div className={styles.content}>
        {children}
      </div>
    </div>
  );
}

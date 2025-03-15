import React from 'react';
import clsx from 'clsx';
import type { User } from '@site/src/data/users';
import ShowcaseCard from '../ShowcaseCard';
import styles from './styles.module.css';

export default function ShowcaseCards({users}: {users: User[]}): JSX.Element {
  // Keep only unique entries by title
  const uniqueUsers = users.filter((user, index, self) =>
    index === self.findIndex((u) => u.title === user.title)
  );

  if (uniqueUsers.length === 0) {
    return (
      <section className="container margin-top--lg margin-bottom--xl">
        <h2>No results found</h2>
        <p>Try adjusting your search or filter criteria.</p>
      </section>
    );
  }

  return (
    <section className="container margin-top--lg margin-bottom--xl">
      <div className={clsx('margin-bottom--md')}>
        <h2>{uniqueUsers.length} {uniqueUsers.length === 1 ? 'Site' : 'Packages'}</h2>
      </div>
      <ul className={clsx('clean-list', styles.showcaseList)}>
        {uniqueUsers.map((user) => (
          <ShowcaseCard key={user.title + user.source} user={user} />
        ))}
      </ul>
    </section>
  );
}

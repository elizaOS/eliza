import React, { useState, useMemo } from 'react';
import { type User, sortedUsers } from '@site/src/data/users';
import ShowcaseSearchBar from '../pages/showcase/_components/ShowcaseSearchBar';
import ShowcaseCards from '../pages/showcase/_components/ShowcaseCards';
import ShowcaseFilters from '../pages/showcase/_components/ShowcaseFilters';
import Link from '@docusaurus/Link';
import styles from '../pages/showcase/_components/ShowcaseLayout/styles.module.css';

const TITLE = 'elizaOS Packages';
const DESCRIPTION = 'Discover the awesome plugins in the eliza ecosystem.';
const GITHUB_LINK = 'https://github.com/elizaos-plugins/registry';

function ShowcaseHeader() {
  return (
    <section className="margin-top--lg margin-bottom--lg text--center">
      <h1>{TITLE}</h1>
      <p>{DESCRIPTION}</p>
      <div className={styles.submitButton}>
        <Link
          className="button button--primary"
          to={GITHUB_LINK}>
          Submit your plugin
        </Link>
      </div>
    </section>
  );
}

function filterUsers(users: User[], search: string, selectedTags: string[], operator: 'OR' | 'AND') {
  // First deduplicate the input array
  const uniqueUsers = users.filter((user, index, self) =>
    index === self.findIndex((u) => u.title === user.title)
  );

  return uniqueUsers.filter(user => {
    // Search filter
    if (search) {
      const searchValue = search.toLowerCase().trim();
      if (!user.title.toLowerCase().includes(searchValue) &&
          !user.description.toLowerCase().includes(searchValue)) {
        return false;
      }
    }

    // Tags filter
    if (selectedTags.length === 0) {
      return true;
    }

    if (operator === 'AND') {
      return selectedTags.every(tag => user.tags.includes(tag));
    }
    return selectedTags.some(tag => user.tags.includes(tag));
  });
}

export default function ShowcaseComponent(): JSX.Element {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [operator, setOperator] = useState<'OR' | 'AND'>('OR');
  const [searchValue, setSearchValue] = useState('');

  const toggleTag = (tag: string) => {
    setSelectedTags(tags =>
      tags.includes(tag)
        ? tags.filter(t => t !== tag)
        : [...tags, tag]
    );
  };

  const toggleOperator = () => {
    setOperator(op => op === 'OR' ? 'AND' : 'OR');
  };

  const filteredUsers = useMemo(() => {
    return filterUsers(sortedUsers, searchValue, selectedTags, operator);
  }, [searchValue, selectedTags, operator]);

  return (
    <div>
      <ShowcaseHeader />
      
      <div className="container">
        <div className={styles.filtersContainer}>
          <div className={styles.filtersRow}>
            <ShowcaseFilters
              selectedTags={selectedTags}
              toggleTag={toggleTag}
              operator={operator}
              toggleOperator={toggleOperator}
            />
            <ShowcaseSearchBar 
              onChange={setSearchValue}
              value={searchValue}
            />
          </div>
        </div>
        
        <ShowcaseCards users={filteredUsers} />
      </div>
    </div>
  );
}

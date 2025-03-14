import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {Tags, type TagType, type User} from '../../../../data/users';
import styles from './styles.module.css';

function TagIcon({label, color}: {label: string; color: string}) {
  return (
    <span
      style={{
        backgroundColor: color,
        width: 7,
        height: 7,
        borderRadius: '50%',
        marginLeft: 2,
        marginRight: 6,
      }}
    />
  );
}

function getShortLabel(label: string): string {
  // Convert longer tag names to shorter versions for display consistency
  switch (label.toLowerCase()) {
    case 'favorite':
      return 'favorite';
    case 'adapter':
      return 'adapter';
    case 'client':
      return 'client';
    case 'plugin':
      return 'plugin';
    default:
      return label;
  }
}

function ShowcaseCardTag({tags}: {tags: TagType[]}) {
  return (
    <>
      {tags.map((tag) => {
        const {label, color} = Tags[tag];
        const displayLabel = getShortLabel(label);
        
        return (
          <li key={tag} className={styles.tag} title={label}>
            <TagIcon label={label} color={color} />
            <span className={styles.textLabel}>{displayLabel.toLowerCase()}</span>
          </li>
        );
      })}
    </>
  );
}

export default function ShowcaseCard({user}: {user: User}) {
    // Function to convert title to documentation link
  const getDocLink = (user: User) => {
    const baseUrl = '/eliza/packages/';  // Make sure to include your baseUrl prefix
    let category = '';
    
    if (user.tags.includes('adapter')) {
      category = 'adapters/';
    } else if (user.tags.includes('client')) {
      category = 'clients/';
    } else if (user.tags.includes('plugin')) {
      category = 'plugins/';
    }
    
    // Extract package name from title
    // Convert to lowercase and remove spaces/special chars
    const slug = user.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    
    return `${baseUrl}${category}${slug}`;
  };

  return (
    <li key={user.title} className="card shadow--md">
      <div className={clsx('card__image', styles.showcaseCardImage)}>
        {user.preview && (
          <img 
            src={user.preview} 
            alt={user.title}
            loading="lazy"
            className={styles.cardImage} 
          />
        )}
      </div>
      <div className="card__body">
        <div className={styles.showcaseCardHeader}>
          <h4 className={styles.showcaseCardTitle}>
            <Link href={user.website} className={styles.showcaseCardLink}>
              {user.title}
            </Link>
          </h4>
          {user.source && (
            <Link
              href={user.source}
              className={clsx(
                'button button--secondary button--sm',
                styles.showcaseCardSrcBtn,
              )}>
              source
            </Link>
          )}
        </div>
        <p className={styles.showcaseCardBody}>{user.description}</p>
      </div>
      <div className={clsx('card__footer', styles.cardFooter)}>
        <div className={styles.tagContainer}>
          <ShowcaseCardTag tags={user.tags.filter(tag => tag)} />
        </div>
        <Link
          to={getDocLink(user)}
          className={clsx('button button--primary button--sm', styles.readmeBtn)}
        >
          Readme
        </Link>
      </div>
    </li>
  );
}

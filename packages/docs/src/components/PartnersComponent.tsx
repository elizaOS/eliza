import React from 'react';
import type { JSX } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import { sortedPartners } from '../data/partners';
import styles from './PartnersComponent/styles.module.css';

function PartnerCard({ partner }) {
  return (
    <Link to={`/partners/${partner.slug}/`} className={clsx('card', styles.partnerCard)}>
      <div className={styles.partnerImageContainer}>
        <img src={partner.preview} alt={partner.title} className={styles.partnerImage} />
      </div>
      <div className={styles.partnerContent}>
        <h3 className={styles.partnerTitle}>{partner.title}</h3>
        <p className={styles.partnerDescription}>{partner.description}</p>
      </div>
    </Link>
  );
}

export default function PartnersComponent(): JSX.Element {
  return (
    <div className={styles.partnersContainer}>
      <div className={styles.partnersGrid}>
        {sortedPartners.map((partner) => (
          <PartnerCard key={partner.title} partner={partner} />
        ))}
      </div>
    </div>
  );
}

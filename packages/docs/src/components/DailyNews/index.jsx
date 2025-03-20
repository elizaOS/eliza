// src/components/DailyNews/index.jsx
import React, { useState, useEffect, useRef } from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

export default function DailyNews() {
  const [newsData, setNewsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentDate, setCurrentDate] = useState('');
  const [dateOffset, setDateOffset] = useState(0);
  const scrollContainerRef = useRef(null);

  useEffect(() => {
    const fetchNews = async () => {
      try {
        setLoading(true);

        // Calculate the date based on current offset
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - dateOffset);
        const dateStr = targetDate.toISOString().split('T')[0];

        // If dateOffset is 0, try to fetch the latest news first
        let response;
        if (dateOffset === 0) {
          response = await fetch('https://m3-org.github.io/ai-news/elizaos/json/daily.json');
        }

        // If we need a specific date or daily isn't available
        if (dateOffset > 0 || !response || !response.ok) {
          response = await fetch(`https://m3-org.github.io/ai-news/elizaos/json/${dateStr}.json`);
          if (!response.ok) {
            throw new Error(`No news available for ${dateStr}`);
          }
        }

        const data = await response.json();
        setNewsData(data);
        setCurrentDate(dateStr);
      } catch (err) {
        console.error('Error fetching news:', err);
        setError(err.message || 'Failed to load news updates.');
      } finally {
        setLoading(false);
      }
    };

    fetchNews();
  }, [dateOffset]);

  // Format the date for display
  const formatDate = (dateString) => {
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    return new Date(dateString).toLocaleDateString(undefined, options);
  };

  // Next day handler (go back in time)
  const handlePrevDay = () => {
    setDateOffset((prev) => prev + 1);
  };

  // Previous day handler (go forward in time)
  const handleNextDay = () => {
    if (dateOffset > 0) {
      setDateOffset((prev) => prev - 1);
    }
  };

  // Scroll handlers
  const handleScrollLeft = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollBy({ left: -300, behavior: 'smooth' });
    }
  };

  const handleScrollRight = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollBy({ left: 300, behavior: 'smooth' });
    }
  };

  // Get flattened news items from all categories
  const getAllNewsItems = () => {
    if (!newsData || !newsData.categories) return [];

    return newsData.categories
      .flatMap((category) =>
        category.content.map((item) => ({
          ...item,
          category: category.title,
          topic: category.topic,
        }))
      )
      .slice(0, 12); // Limit to 12 items total
  };

  return (
    <section className={styles.newsSection}>
      <div className="container">
        <div className={styles.newsHeader}>
          <Heading as="h2" className={styles.newsTitle}>
            News
          </Heading>

          <div className={styles.dateNavigation}>
            <button onClick={handlePrevDay} className={styles.dateButton} aria-label="Previous day">
              ←
            </button>

            <div className={styles.dateDisplay}>
              {currentDate && <span>{formatDate(currentDate)}</span>}
            </div>

            <button
              onClick={handleNextDay}
              className={styles.dateButton}
              disabled={dateOffset === 0}
              aria-label="Next day"
            >
              →
            </button>
          </div>

          <Link
            className={clsx('button button--outline button--secondary', styles.viewAllButton)}
            to="/news"
          >
            View All
          </Link>
        </div>

        {loading ? (
          <div className={styles.loadingContainer}>
            <div className={styles.loadingSpinner}></div>
            <p>Loading updates...</p>
          </div>
        ) : error ? (
          <div className={styles.errorContainer}>
            <p>{error}</p>
          </div>
        ) : (
          <div className={styles.carouselContainer}>
            <button
              onClick={handleScrollLeft}
              className={clsx(styles.scrollButton, styles.scrollButtonLeft)}
              aria-label="Scroll left"
            >
              ‹
            </button>

            <div className={styles.newsCarousel} ref={scrollContainerRef}>
              {getAllNewsItems().map((item, idx) => (
                <div key={idx} className={styles.newsCard}>
                  {item.topic && <span className={styles.topicBadge}>{item.topic}</span>}
                  <h4 className={styles.itemCategory}>{item.category}</h4>

                  <div className={styles.newsContent}>
                    <p className={styles.newsText}>{item.text}</p>
                    <div className={styles.textFade}></div>
                  </div>

                  {item.sources && item.sources.length > 0 && (
                    <div className={styles.sourceLinks}>
                      {item.sources.slice(0, 1).map((source, sourceIdx) =>
                        source.startsWith('http') ? (
                          <Link
                            key={sourceIdx}
                            to={source}
                            className={styles.sourceLink}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Source
                          </Link>
                        ) : null
                      )}
                      {item.sources.length > 1 && (
                        <span className={styles.moreSources}>+{item.sources.length - 1}</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button
              onClick={handleScrollRight}
              className={clsx(styles.scrollButton, styles.scrollButtonRight)}
              aria-label="Scroll right"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

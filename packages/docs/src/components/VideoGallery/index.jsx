import React, { useState, useEffect } from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

// List of video categories
const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'animation', label: 'Animations' },
  { id: 'events', label: 'Events' },
  { id: 'streams', label: 'Streams' },
  { id: 'community', label: 'Community' },
];

const VIDEOS = [
  {
    title: 'ElizaOS Rebrand',
    description: 'Season finale with Shaw and the autonomous investor. Gauntlet thrown.',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/rebrand-vid.mp4',
    thumbnail: '/img/video-thumbnails/rebrand-thumb.jpg',
  },
  {
    title: 'Agent Bazaar',
    description: 'Envisioning the bazaar of AI agents, an open AI ecosystem powered by ElizaOS.',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/bazaar2.mp4',
    thumbnail: '/img/video-thumbnails/bazaar-thumb.jpg',
  },
  {
    title: 'Neon Street',
    description:
      'Unreleased animation of the gang checking out a cyberpunk alley. Meant to express the bazaar, but lacked the liveliness of a marketplace.',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/rebrand_tokyo.mp4',
    thumbnail: '/img/video-thumbnails/neon-thumb.jpg',
  },
  {
    title: 'Clank Tank Promo',
    description:
      'Promotional video for Clank Tank, a game show simulator where you pitch AI judges.',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/clanktank-promo2.mp4',
    thumbnail: '/img/video-thumbnails/clanktank-thumb.jpg',
    newLink: 'https://m3org.com/tv',
  },
  {
    title: 'Autonomous Hackathon Promo',
    description:
      'Promo made during the Autonomous Hackathon hosted by gaianet where the judges were AI agents, December 2024.',
    category: 'events',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/FinishedHackVid.mp4',
    thumbnail: '/img/video-thumbnails/hack-thumb.jpg',
  },
  {
    title: 'AI Agent Dev School Part 3',
    description:
      "Form-Filling Frenzy & Eliza's Wild Ride - Learn how to build form completion features and extract user data with the Eliza framework.",
    category: 'streams',
    isYouTube: true,
    src: 'https://www.youtube.com/embed/Y1DiqSVy4aU',
    docLink: '/community/Streams/12-2024/2024-12-05',
  },
  {
    title: 'AI Agent Dev School Part 4',
    description:
      "AI Pizza: Hacking Eliza for Domino's Delivery plus TEE Deep Dive. Learn about trusted execution environments and practical agent development.",
    category: 'streams',
    isYouTube: true,
    src: 'https://www.youtube.com/embed/6I9e9pJprDI',
    docLink: '/community/Streams/12-2024/2024-12-10',
  },
  {
    title: 'AI Agent Dev School Part 2',
    description:
      'Building Complex AI Agents with Actions, Providers, & Evaluators. Dive deep into the core components of the Eliza framework.',
    category: 'streams',
    isYouTube: true,
    src: 'https://www.youtube.com/embed/XenGeAcPAQo',
    docLink: '/community/Streams/12-2024/2024-12-03',
  },
  {
    title: 'DegenAI Dancing',
    description: 'Spartan literally just vibing fr',
    category: 'community',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/SPARTA_02B.mp4',
    thumbnail: '/img/video-thumbnails/sparta-thumb.jpg',
  },
  {
    title: 'The Tribute',
    description: 'DegenAI seems to be dozing off again, this time about people gifting him coins.',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/throne.mp4',
    thumbnail: '/img/video-thumbnails/throne-thumb.jpg',
  },
  {
    title: 'AI Agent School',
    description: 'Shaw teaching AI agents about how to make AI agents',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/dubbing_office.mp4',
    thumbnail: '/img/video-thumbnails/dubbing-thumb.jpg',
  },
  {
    title: 'Beach Scene Demo',
    description: 'Spartan and aixvc emjoying a swim. No dumping allowed.',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/BeachScene.mp4',
    thumbnail: '/img/video-thumbnails/beach-thumb.jpg',
  },
  {
    title: 'New Year 2025',
    description:
      'Fun video to celebrate the new years, made with new AI animation rendering techniques.',
    category: 'community',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/NewYearsCeleb.mov',
    thumbnail: '/img/video-thumbnails/newyear-thumb.jpg',
  },
  {
    title: 'Solana AI Hackathon',
    description:
      'Promo for the Solana AI hackathon, the first of its kind with 250k+ in prizes,  December 2024.',
    category: 'events',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/NoMog.mp4',
    thumbnail: '/img/video-thumbnails/solanahack-thumb.jpg',
  },
  {
    title: 'Internet Capital Markets',
    description: 'Envisioning autonomous AI agent traders making money for the DAO 24/7.',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/StonkMarketRender02.mp4',
    thumbnail: '/img/video-thumbnails/stonk2-thumb.jpg',
    newLink: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/Stonk_01.mp4',
  },
  {
    title: 'AI Agent Council',
    description:
      'Concept trailer for The AI Council, a simulation show where a round of AI agents provide tailored feedback.',
    category: 'animation',
    src: 'http://arweave.net/7XFrcz5fQjWPJopvSGj-Bi3gzE7gsj_7Ng87-dl7xbg',
    thumbnail: '/img/video-thumbnails/council-thumb.jpg',
  },
  {
    title: 'Gangnam Meetup',
    description:
      'Shaw visits Korea in January 2025 to enjoy some pizza, code, and good conversations..',
    category: 'events',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/gangnam.mp4',
    thumbnail: '/img/video-thumbnails/pizza-thumb.jpg',
    newLink: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/12303.mp4',
  },
  {
    title: 'Voting Booth',
    description:
      'Voting for spot listing on ByBit. We ended up having all the votes before the animation was done.',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/votingbooth.mp4',
    thumbnail: '/img/video-thumbnails/vote-thumb.jpg',
  },
  {
    title: 'Shaw Runner',
    description: 'A creative tribute to classic cyberpunk aesthetics.',
    category: 'animation',
    src: 'https://arweave.net/Tguqw-tvyfVIhOh4sJC_-3LFYyMy_NURPbimnnrg2HU/shawrunner.mp4',
    thumbnail: '/img/video-thumbnails/shawrunner-thumb.jpg',
  },
];

// Default thumbnail for videos
const DEFAULT_THUMBNAIL = '/img/video-default-thumb.jpg';

// Video player component with lazy loading
function VideoPlayer({ video }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [thumbnailError, setThumbnailError] = useState(false);

  if (video.isYouTube) {
    // YouTube embed
    return (
      <div className={styles.videoPlayer}>
        <iframe
          src={video.src}
          title={video.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          loading="lazy"
        />
      </div>
    );
  }

  // Arweave video with lazy loading
  return (
    <div className={styles.videoPlayer}>
      <video
        controls
        width="100%"
        preload={isLoaded ? 'auto' : 'none'}
        poster={thumbnailError ? DEFAULT_THUMBNAIL : video.thumbnail || DEFAULT_THUMBNAIL}
        loading="lazy"
        onClick={() => setIsLoaded(true)}
        onPlay={() => setIsLoaded(true)}
      >
        <source src={video.src} type="video/mp4" />
        Your browser does not support the video tag.
      </video>

      {!isLoaded && (
        <div className={styles.videoOverlay} onClick={() => setIsLoaded(true)}>
          <div className={styles.playButton}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <div className={styles.videoTitle}>{video.title}</div>
          <img
            src={video.thumbnail || DEFAULT_THUMBNAIL}
            alt={`${video.title} thumbnail`}
            className={styles.thumbnailImg}
            onError={() => setThumbnailError(true)}
          />
        </div>
      )}
    </div>
  );
}

// Main video gallery component
export default function VideoGallery() {
  const [activeCategory, setActiveCategory] = useState('all');

  // Filter videos based on selected category
  const filteredVideos = VIDEOS.filter(
    (video) => activeCategory === 'all' || video.category === activeCategory
  );

  // Group videos by category for display
  const videosByCategory = VIDEOS.reduce((acc, video) => {
    if (!acc[video.category]) {
      acc[video.category] = [];
    }
    acc[video.category].push(video);
    return acc;
  }, {});

  // Category names mapping
  const categoryNames = {
    animation: 'Animations',
    streams: 'Live Streams',
    events: 'Event Promos',
    community: 'Community Creations',
  };

  return (
    <div className={styles.videoGalleryContainer}>
      {/* Filter buttons */}
      <div className={styles.filterButtons}>
        {CATEGORIES.map((category) => (
          <button
            key={category.id}
            className={clsx(styles.filterButton, {
              [styles.filterButtonActive]: activeCategory === category.id,
            })}
            onClick={() => setActiveCategory(category.id)}
          >
            {category.label}
          </button>
        ))}
      </div>

      {/* Performance note */}
      <div className={styles.performanceNote}>
        <p>
          Videos use lazy loading for better performance. They will only start loading when you
          press play.
        </p>
      </div>

      {/* When "All" is selected, show videos by category sections */}
      {activeCategory === 'all' ? (
        Object.keys(categoryNames).map(
          (category) =>
            videosByCategory[category] &&
            videosByCategory[category].length > 0 && (
              <div key={category} className={styles.videoSection}>
                <h2 id={category}>{categoryNames[category]}</h2>
                <div className={styles.videoGrid}>
                  {videosByCategory[category].map((video, index) => (
                    <div key={index} className={styles.videoCard}>
                      <VideoPlayer video={video} />
                      <div className={styles.videoInfo}>
                        <h3>{video.title}</h3>
                        <p>{video.description}</p>
                        {video.docLink && (
                          <a href={video.docLink} className={styles.videoLink}>
                            View notes →
                          </a>
                        )}
                        {video.newLink && (
                          <a
                            href={video.newLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.videoLink}
                          >
                            See more →
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
        )
      ) : (
        // When a specific category is selected, show flat list of videos
        <div className={styles.videoGrid}>
          {filteredVideos.map((video, index) => (
            <div key={index} className={styles.videoCard}>
              <VideoPlayer video={video} />
              <div className={styles.videoInfo}>
                <h3>{video.title}</h3>
                <p>{video.description}</p>
                {video.docLink && (
                  <a href={video.docLink} className={styles.videoLink}>
                    View notes →
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

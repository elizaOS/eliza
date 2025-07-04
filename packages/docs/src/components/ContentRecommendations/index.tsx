import React, { useState, useEffect } from 'react';
import { useLocation, useHistory } from '@docusaurus/router';
import { ArrowRight, BookOpen, Code, Zap, Users, TrendingUp, Clock, Star } from 'lucide-react';
import styles from './styles.module.css';

interface Recommendation {
  id: string;
  title: string;
  description: string;
  url: string;
  type: 'next-step' | 'related' | 'popular' | 'trending' | 'beginner-friendly';
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimatedTime: string;
  tags: string[];
  icon: React.ReactNode;
  relevanceScore: number;
}

interface UserContext {
  currentPath: string;
  userTrack: 'simple' | 'customize' | 'technical' | 'general';
  visitedPages: string[];
  timeSpent: number;
  completedSections: string[];
}

export default function ContentRecommendations(): JSX.Element {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [userContext, setUserContext] = useState<UserContext>({
    currentPath: '',
    userTrack: 'general',
    visitedPages: [],
    timeSpent: 0,
    completedSections: [],
  });
  const [showAll, setShowAll] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const location = useLocation();
  const history = useHistory();

  // Track user behavior and context
  useEffect(() => {
    const currentPath = location.pathname;

    // Determine user track
    let userTrack: 'simple' | 'customize' | 'technical' | 'general' = 'general';
    if (currentPath.includes('/simple/')) userTrack = 'simple';
    else if (currentPath.includes('/customize/')) userTrack = 'customize';
    else if (currentPath.includes('/technical/')) userTrack = 'technical';

    // Update user context
    setUserContext((prev) => ({
      ...prev,
      currentPath,
      userTrack,
      visitedPages: [...new Set([...prev.visitedPages, currentPath])].slice(-10), // Keep last 10 pages
    }));

    // Load recommendations based on context
    generateRecommendations(currentPath, userTrack);
  }, [location.pathname]);

  // Generate AI-powered recommendations
  const generateRecommendations = async (currentPath: string, userTrack: string) => {
    setIsLoading(true);

    try {
      // Simulate AI processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      const allRecommendations = getAllRecommendations();
      const contextualRecommendations = getContextualRecommendations(
        currentPath,
        userTrack,
        allRecommendations
      );

      setRecommendations(contextualRecommendations);
    } catch (error) {
      console.error('Error generating recommendations:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Get all available recommendations
  const getAllRecommendations = (): Recommendation[] => {
    return [
      // Getting Started Recommendations
      {
        id: 'quickstart',
        title: 'Quick Start Guide',
        description: 'Get ElizaOS up and running in 5 minutes',
        url: '/docs/quickstart',
        type: 'next-step',
        difficulty: 'beginner',
        estimatedTime: '5 min',
        tags: ['getting-started', 'setup', 'beginner'],
        icon: <Zap size={20} />,
        relevanceScore: 0.9,
      },
      {
        id: 'installation',
        title: 'Installation Guide',
        description: 'Detailed installation instructions for all platforms',
        url: '/docs/installation',
        type: 'next-step',
        difficulty: 'beginner',
        estimatedTime: '10 min',
        tags: ['installation', 'setup', 'platform'],
        icon: <BookOpen size={20} />,
        relevanceScore: 0.85,
      },
      {
        id: 'first-agent',
        title: 'Create Your First Agent',
        description: 'Step-by-step guide to creating your first AI agent',
        url: '/docs/tutorials/first-agent',
        type: 'next-step',
        difficulty: 'beginner',
        estimatedTime: '15 min',
        tags: ['agents', 'tutorial', 'beginner'],
        icon: <Users size={20} />,
        relevanceScore: 0.95,
      },

      // Configuration & Customization
      {
        id: 'agent-config',
        title: 'Agent Configuration',
        description: 'Learn how to configure and customize your agents',
        url: '/docs/core/agents',
        type: 'related',
        difficulty: 'intermediate',
        estimatedTime: '20 min',
        tags: ['agents', 'configuration', 'customization'],
        icon: <Code size={20} />,
        relevanceScore: 0.8,
      },
      {
        id: 'memory-system',
        title: 'Understanding Agent Memory',
        description: 'Deep dive into how agents store and recall information',
        url: '/docs/core/memory',
        type: 'related',
        difficulty: 'intermediate',
        estimatedTime: '25 min',
        tags: ['memory', 'agents', 'advanced'],
        icon: <BookOpen size={20} />,
        relevanceScore: 0.75,
      },

      // Development & Advanced Topics
      {
        id: 'plugin-development',
        title: 'Plugin Development',
        description: 'Create custom plugins to extend ElizaOS functionality',
        url: '/docs/plugins/development',
        type: 'next-step',
        difficulty: 'advanced',
        estimatedTime: '45 min',
        tags: ['plugins', 'development', 'advanced'],
        icon: <Code size={20} />,
        relevanceScore: 0.7,
      },
      {
        id: 'api-reference',
        title: 'API Reference',
        description: 'Complete API documentation and reference',
        url: '/api',
        type: 'related',
        difficulty: 'intermediate',
        estimatedTime: '30 min',
        tags: ['api', 'reference', 'development'],
        icon: <BookOpen size={20} />,
        relevanceScore: 0.6,
      },
      {
        id: 'custom-actions',
        title: 'Custom Actions',
        description: 'Build custom actions for your agents',
        url: '/docs/core/actions',
        type: 'related',
        difficulty: 'advanced',
        estimatedTime: '35 min',
        tags: ['actions', 'development', 'advanced'],
        icon: <Zap size={20} />,
        relevanceScore: 0.65,
      },

      // Community & Resources
      {
        id: 'community-guides',
        title: 'Community Guides',
        description: 'Learn from community-contributed tutorials and guides',
        url: '/community',
        type: 'popular',
        difficulty: 'beginner',
        estimatedTime: '10 min',
        tags: ['community', 'guides', 'resources'],
        icon: <Users size={20} />,
        relevanceScore: 0.5,
      },
      {
        id: 'troubleshooting',
        title: 'Troubleshooting Guide',
        description: 'Common issues and their solutions',
        url: '/docs/troubleshooting',
        type: 'popular',
        difficulty: 'beginner',
        estimatedTime: '15 min',
        tags: ['troubleshooting', 'help', 'issues'],
        icon: <BookOpen size={20} />,
        relevanceScore: 0.4,
      },

      // Track-specific recommendations
      {
        id: 'simple-track',
        title: 'Simple Track Overview',
        description: 'Non-technical guide to using ElizaOS',
        url: '/docs/simple',
        type: 'beginner-friendly',
        difficulty: 'beginner',
        estimatedTime: '8 min',
        tags: ['simple', 'non-technical', 'beginner'],
        icon: <Star size={20} />,
        relevanceScore: 0.8,
      },
      {
        id: 'customize-track',
        title: 'Customize Track Guide',
        description: 'Power user customization and configuration',
        url: '/docs/customize',
        type: 'related',
        difficulty: 'intermediate',
        estimatedTime: '25 min',
        tags: ['customize', 'configuration', 'power-user'],
        icon: <Code size={20} />,
        relevanceScore: 0.75,
      },
      {
        id: 'technical-track',
        title: 'Technical Track Deep Dive',
        description: 'Complete developer documentation and guides',
        url: '/docs/technical',
        type: 'related',
        difficulty: 'advanced',
        estimatedTime: '60 min',
        tags: ['technical', 'development', 'advanced'],
        icon: <Code size={20} />,
        relevanceScore: 0.7,
      },
    ];
  };

  // Get contextual recommendations based on current page and user track
  const getContextualRecommendations = (
    currentPath: string,
    userTrack: string,
    allRecommendations: Recommendation[]
  ): Recommendation[] => {
    // Filter and score recommendations based on context
    const contextualRecommendations = allRecommendations
      .map((rec) => {
        let score = rec.relevanceScore;

        // Boost score based on user track
        if (userTrack === 'simple' && rec.tags.includes('simple')) score += 0.3;
        if (userTrack === 'customize' && rec.tags.includes('customize')) score += 0.3;
        if (userTrack === 'technical' && rec.tags.includes('technical')) score += 0.3;

        // Boost score based on difficulty match
        if (userTrack === 'simple' && rec.difficulty === 'beginner') score += 0.2;
        if (userTrack === 'customize' && rec.difficulty === 'intermediate') score += 0.2;
        if (userTrack === 'technical' && rec.difficulty === 'advanced') score += 0.2;

        // Boost score based on current page context
        if (currentPath.includes('/docs/quickstart') && rec.tags.includes('agents')) score += 0.25;
        if (currentPath.includes('/docs/installation') && rec.tags.includes('getting-started'))
          score += 0.25;
        if (currentPath.includes('/docs/agents') && rec.tags.includes('configuration'))
          score += 0.25;
        if (currentPath.includes('/docs/plugins') && rec.tags.includes('development'))
          score += 0.25;
        if (currentPath.includes('/api') && rec.tags.includes('development')) score += 0.25;

        // Reduce score for already visited pages
        if (userContext.visitedPages.includes(rec.url)) score -= 0.3;

        return { ...rec, relevanceScore: score };
      })
      .filter((rec) => rec.relevanceScore > 0.3) // Only show relevant recommendations
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 8); // Limit to top 8 recommendations

    return contextualRecommendations;
  };

  const handleRecommendationClick = (url: string) => {
    history.push(url);
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'beginner':
        return 'var(--ifm-color-success)';
      case 'intermediate':
        return 'var(--ifm-color-warning)';
      case 'advanced':
        return 'var(--ifm-color-danger)';
      default:
        return 'var(--ifm-color-primary)';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'next-step':
        return 'Next Step';
      case 'related':
        return 'Related';
      case 'popular':
        return 'Popular';
      case 'trending':
        return 'Trending';
      case 'beginner-friendly':
        return 'Beginner Friendly';
      default:
        return type;
    }
  };

  const displayedRecommendations = showAll ? recommendations : recommendations.slice(0, 4);

  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <TrendingUp size={24} />
          <h2>Smart Recommendations</h2>
        </div>
        <div className={styles.loadingGrid}>
          {[...Array(4)].map((_, i) => (
            <div key={i} className={styles.loadingCard}>
              <div className={styles.loadingSkeleton}></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (recommendations.length === 0) {
    return null;
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <TrendingUp size={24} />
        <h2>Smart Recommendations</h2>
        <p>Based on your current page and learning path</p>
      </div>

      <div className={styles.recommendationsGrid}>
        {displayedRecommendations.map((rec) => (
          <div
            key={rec.id}
            className={`${styles.recommendationCard} ${styles[rec.type]}`}
            onClick={() => handleRecommendationClick(rec.url)}
          >
            <div className={styles.cardHeader}>
              <div className={styles.cardIcon}>{rec.icon}</div>
              <div className={styles.cardMeta}>
                <span className={styles.cardType}>{getTypeLabel(rec.type)}</span>
                <span className={styles.cardTime}>
                  <Clock size={14} />
                  {rec.estimatedTime}
                </span>
              </div>
            </div>

            <div className={styles.cardContent}>
              <h3 className={styles.cardTitle}>{rec.title}</h3>
              <p className={styles.cardDescription}>{rec.description}</p>
            </div>

            <div className={styles.cardFooter}>
              <div className={styles.cardTags}>
                {rec.tags.slice(0, 2).map((tag) => (
                  <span key={tag} className={styles.tag}>
                    {tag}
                  </span>
                ))}
              </div>
              <div className={styles.cardDifficulty}>
                <span
                  className={styles.difficultyBadge}
                  style={{ backgroundColor: getDifficultyColor(rec.difficulty) }}
                >
                  {rec.difficulty}
                </span>
              </div>
            </div>

            <div className={styles.cardAction}>
              <ArrowRight size={16} />
            </div>
          </div>
        ))}
      </div>

      {recommendations.length > 4 && (
        <div className={styles.showMoreContainer}>
          <button className={styles.showMoreButton} onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show Less' : `Show ${recommendations.length - 4} More`}
          </button>
        </div>
      )}
    </div>
  );
}

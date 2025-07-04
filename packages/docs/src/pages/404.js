import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';

export default function NotFound() {
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    // Analyze the broken URL to provide smart suggestions
    const brokenPath = window.location.pathname;
    const pathSegments = brokenPath.split('/').filter(Boolean);

    const suggestedLinks = [];

    // Check for common patterns
    if (brokenPath.includes('character')) {
      suggestedLinks.push({
        title: 'Character Creation Guide',
        path: '/docs/simple/guides/character-creation',
        description: 'Learn how to create custom characters for your agents',
      });
      suggestedLinks.push({
        title: 'Character Templates Gallery',
        path: '/docs/simple/templates/gallery',
        description: 'Ready-to-use character templates',
      });
      suggestedLinks.push({
        title: 'Character Builder Tool',
        path: '/docs/customize/character-builder',
        description: 'Interactive character design studio',
      });
    }

    if (brokenPath.includes('customize')) {
      suggestedLinks.push({
        title: 'Customization Overview',
        path: '/docs/customize/overview',
        description: 'Start customizing your ElizaOS experience',
      });
      suggestedLinks.push({
        title: 'Visual Customization Lab',
        path: '/docs/customize/visual-lab',
        description: "Design your agent's visual identity",
      });
    }

    if (brokenPath.includes('api')) {
      suggestedLinks.push({
        title: 'API Reference',
        path: '/api',
        description: 'Complete API documentation',
      });
      suggestedLinks.push({
        title: 'REST API',
        path: '/docs/rest',
        description: 'RESTful API endpoints',
      });
    }

    if (brokenPath.includes('plugin')) {
      suggestedLinks.push({
        title: 'Plugin Packages',
        path: '/packages?tags=plugin',
        description: 'Available ElizaOS plugins',
      });
      suggestedLinks.push({
        title: 'Plugin Development',
        path: '/docs/technical/plugins',
        description: 'Build custom plugins',
      });
    }

    if (
      brokenPath.includes('discord') ||
      brokenPath.includes('telegram') ||
      brokenPath.includes('twitter')
    ) {
      suggestedLinks.push({
        title: 'Discord Setup Guide',
        path: '/docs/simple/guides/discord-setup',
        description: 'Set up your Discord bot',
      });
      suggestedLinks.push({
        title: 'Telegram Setup Guide',
        path: '/docs/simple/guides/telegram-setup',
        description: 'Configure Telegram integration',
      });
      suggestedLinks.push({
        title: 'Twitter Setup Guide',
        path: '/docs/simple/guides/twitter-setup',
        description: 'Create a Twitter bot',
      });
    }

    // Always include these core links
    suggestedLinks.push({
      title: 'Quick Start Guide',
      path: '/docs/simple/getting-started/quick-start',
      description: 'Get started in 5 minutes',
    });
    suggestedLinks.push({
      title: 'Documentation Home',
      path: '/docs',
      description: 'Browse all documentation',
    });

    // Remove duplicates
    const uniqueLinks = suggestedLinks.filter(
      (link, index, self) => index === self.findIndex((l) => l.path === link.path)
    );

    setSuggestions(uniqueLinks.slice(0, 6)); // Show max 6 suggestions
  }, []);

  return (
    <Layout title="Page Not Found">
      <main className="container margin-vert--xl">
        <div className="row">
          <div className="col col--8 col--offset-2">
            <div className="glass-base" style={{ padding: '3rem', textAlign: 'center' }}>
              <h1 className="hero__title" style={{ fontSize: '4rem', marginBottom: '1rem' }}>
                404
              </h1>
              <p className="hero__subtitle" style={{ fontSize: '1.5rem', marginBottom: '2rem' }}>
                Oops! We couldn't find that page.
              </p>

              <div style={{ marginBottom: '3rem' }}>
                <p style={{ marginBottom: '1rem' }}>
                  The page you're looking for might have been moved or doesn't exist.
                </p>
                <p>Let's get you back on track! 🚀</p>
              </div>

              {suggestions.length > 0 && (
                <div style={{ marginBottom: '3rem' }}>
                  <h2 style={{ marginBottom: '1.5rem' }}>Suggested Pages</h2>
                  <div className="row">
                    {suggestions.map((suggestion, index) => (
                      <div key={index} className="col col--6" style={{ marginBottom: '1rem' }}>
                        <Link
                          to={suggestion.path}
                          className="card padding--md"
                          style={{
                            display: 'block',
                            textDecoration: 'none',
                            height: '100%',
                            background: 'var(--glass-surface)',
                            backdropFilter: 'blur(20px)',
                            border: '1px solid var(--glass-border)',
                            borderRadius: '8px',
                            transition: 'all 0.2s ease',
                          }}
                        >
                          <h4 style={{ marginBottom: '0.5rem' }}>{suggestion.title}</h4>
                          <p
                            style={{
                              fontSize: '0.875rem',
                              color: 'var(--ifm-color-secondary)',
                              marginBottom: 0,
                            }}
                          >
                            {suggestion.description}
                          </p>
                        </Link>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginBottom: '2rem' }}>
                <Link
                  to="/docs"
                  className="button button--primary button--lg"
                  style={{ marginRight: '1rem' }}
                >
                  Go to Documentation
                </Link>
                <Link to="/" className="button button--secondary button--lg">
                  Go to Homepage
                </Link>
              </div>

              <div
                style={{
                  marginTop: '3rem',
                  paddingTop: '2rem',
                  borderTop: '1px solid var(--glass-border)',
                }}
              >
                <p style={{ fontSize: '0.875rem', color: 'var(--ifm-color-secondary)' }}>
                  💡 <strong>Tip:</strong> Use the search bar at the top to quickly find what you're
                  looking for, or check out our{' '}
                  <Link to="/docs/simple/getting-started/quick-start">Quick Start Guide</Link> to
                  get started with ElizaOS.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
}

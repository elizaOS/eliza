import React, { useEffect } from 'react';
import { useLocation } from '@docusaurus/router';

// Custom Root component to handle navigation fixes
export default function Root({ children }) {
  const location = useLocation();

  useEffect(() => {
    // Fix for dropdown hover glitches - implement hover intent
    const setupHoverIntent = () => {
      const dropdowns = document.querySelectorAll('.dropdown--hoverable');

      dropdowns.forEach((dropdown) => {
        let hoverTimer;
        let isHovering = false;

        // Mouse enter - start timer
        dropdown.addEventListener('mouseenter', () => {
          isHovering = true;
          dropdown.removeAttribute('data-hover-intent');

          // Clear any existing timer
          clearTimeout(hoverTimer);

          // Set hover intent after 400ms
          hoverTimer = setTimeout(() => {
            if (isHovering) {
              dropdown.setAttribute('data-hover-intent', 'true');
            }
          }, 400);
        });

        // Mouse leave - clear timer and close
        dropdown.addEventListener('mouseleave', () => {
          isHovering = false;
          clearTimeout(hoverTimer);

          // Add closing class to prevent immediate reopen
          dropdown.classList.add('dropdown--closing');
          dropdown.setAttribute('data-hover-intent', 'false');

          // Remove closing class after transition
          setTimeout(() => {
            dropdown.classList.remove('dropdown--closing');
          }, 300);
        });
      });
    };

    // Fix broken internal links
    const fixBrokenLinks = () => {
      // Common link mappings for broken links
      const linkMappings = {
        // Map old paths to new paths
        '/docs/intro': '/docs',
        '/docs/getting-started': '/docs/simple/getting-started/quick-start',
        '/docs/guides/character-creation': '/docs/simple/guides/character-creation',
        '/docs/customize/character-builder': '/docs/customize/character-builder',
        '/docs/customize/overview': '/docs/customize/overview',
        '/docs/customize/visual-lab': '/docs/customize/visual-lab',
        '/docs/customize/feature-workshop': '/docs/customize/feature-workshop',
        '/docs/customize/analytics': '/docs/customize/analytics',
        '/docs/design-system': '/docs/design-system/index',
        '/docs/design-system/components': '/docs/design-system/components',
        '/docs/design-system/animations': '/docs/design-system/animations',
        '/docs/design-system/performance': '/docs/design-system/performance',
        '/docs/design-system/accessibility': '/docs/design-system/accessibility',
        '/docs/design-system/implementation': '/docs/design-system/implementation',
        // Add more mappings as needed
      };

      // Intercept link clicks
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a');

        if (link && link.href && link.href.includes(window.location.host)) {
          const url = new URL(link.href);
          const pathname = url.pathname.replace(/\/$/, ''); // Remove trailing slash

          // Check if this is a known broken link
          if (linkMappings[pathname]) {
            e.preventDefault();
            window.location.href = linkMappings[pathname];
          }

          // Check for common patterns
          if (
            pathname.includes('/docs/') &&
            !pathname.includes('/docs/simple/') &&
            !pathname.includes('/docs/customize/') &&
            !pathname.includes('/docs/technical/')
          ) {
            // Try redirecting to simple track first
            const simplePath = pathname.replace('/docs/', '/docs/simple/');
            e.preventDefault();
            window.location.href = simplePath;
          }
        }
      });
    };

    // Setup navbar scroll behavior
    const setupNavbarScroll = () => {
      const navbar = document.querySelector('.navbar');
      let lastScrollY = window.scrollY;

      const handleScroll = () => {
        const currentScrollY = window.scrollY;

        if (currentScrollY > 50) {
          navbar?.classList.add('navbar--scrolled');
        } else {
          navbar?.classList.remove('navbar--scrolled');
        }

        lastScrollY = currentScrollY;
      };

      window.addEventListener('scroll', handleScroll, { passive: true });

      return () => {
        window.removeEventListener('scroll', handleScroll);
      };
    };

    // Initialize all fixes
    setupHoverIntent();
    fixBrokenLinks();
    const cleanupScroll = setupNavbarScroll();

    // Cleanup
    return () => {
      cleanupScroll();
    };
  }, [location]);

  // Add 404 handler
  useEffect(() => {
    // Check if we're on a 404 page
    if (location.pathname.includes('404')) {
      const suggestAlternative = () => {
        const path = window.location.pathname;

        // Suggest alternatives based on the broken path
        let suggestion = '/docs';

        if (path.includes('character')) {
          suggestion = '/docs/simple/guides/character-creation';
        } else if (path.includes('customize')) {
          suggestion = '/docs/customize/overview';
        } else if (path.includes('api')) {
          suggestion = '/api';
        } else if (path.includes('package')) {
          suggestion = '/packages';
        }

        // Display suggestion
        const content = document.querySelector('.theme-doc-markdown');
        if (content) {
          const suggestionHTML = `
            <div class="glass-base" style="padding: 2rem; margin: 2rem 0; text-align: center;">
              <h3>Looking for something specific?</h3>
              <p>You might want to try:</p>
              <a href="${suggestion}" class="button button--primary">
                Go to ${
                  suggestion.includes('simple')
                    ? 'Quick Start Guide'
                    : suggestion.includes('customize')
                      ? 'Customization Guide'
                      : suggestion.includes('api')
                        ? 'API Reference'
                        : suggestion.includes('packages')
                          ? 'Packages'
                          : 'Documentation'
                }
              </a>
              <p style="margin-top: 1rem;">Or use the search bar above to find what you're looking for.</p>
            </div>
          `;

          const div = document.createElement('div');
          div.innerHTML = suggestionHTML;
          content.appendChild(div);
        }
      };

      // Add suggestion after a short delay
      setTimeout(suggestAlternative, 100);
    }
  }, [location]);

  return <>{children}</>;
}

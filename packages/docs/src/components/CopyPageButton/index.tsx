import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from '@docusaurus/router';
import { useColorMode } from '@docusaurus/theme-common';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './styles.module.css';

// Define paths to exclude
const EXCLUDED_PATHS = [
  // Exclude API pages
  /^\/api\//,
  /^\/api\/?$/,
  // Exclude packages index
  /^\/packages\/?$/,
  // Add more excluded paths as needed
  // /^\/other-path\//,
];

export default function CopyPageButton(): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { colorMode } = useColorMode();
  const location = useLocation();
  const { siteConfig } = useDocusaurusContext();

  // Check if current path should be excluded
  const isExcludedPath = EXCLUDED_PATHS.some((regex) => regex.test(location.pathname));

  // Early return if path is excluded
  if (isExcludedPath) {
    return null;
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Reset copy success message after 2 seconds
  useEffect(() => {
    if (copySuccess) {
      const timer = setTimeout(() => {
        setCopySuccess(false);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [copySuccess]);

  // Toggle dropdown
  const toggleDropdown = () => {
    setIsOpen(!isOpen);
  };

  // Extract the edit URL from the DOM
  const getEditUrl = () => {
    // Find the "Edit this page" link in the DOM
    const editLinkElement = document.querySelector('a.theme-edit-this-page');
    if (editLinkElement && editLinkElement.getAttribute('href')) {
      return editLinkElement.getAttribute('href');
    }

    // Fallback for local development
    // If we're in local development and we have editUrl configured in docusaurus.config.js
    if (process.env.NODE_ENV === 'development') {
      // Get the edit URL from config
      let editUrl = siteConfig.presets?.[0]?.[1]?.docs?.editUrl || siteConfig.themeConfig?.editUrl;

      if (editUrl) {
        // Convert from tree URL to edit URL if needed
        if (editUrl.includes('/tree/')) {
          editUrl = editUrl.replace('/tree/', '/edit/');
        }

        // Remove trailing slash if present
        const baseEditUrl = editUrl.endsWith('/') ? editUrl.slice(0, -1) : editUrl;

        // Get the current path and remove leading and trailing slashes
        let currentPath = location.pathname;
        currentPath = currentPath.replace(/^\//, '').replace(/\/$/, '');

        // Remove 'docs/' from the beginning if present
        if (currentPath.startsWith('docs/')) {
          currentPath = currentPath.substring(5);
        }

        // Append .md to get the markdown file
        return `${baseEditUrl}/${currentPath}.md`;
      }
    }

    return null;
  };

  // Convert GitHub edit URL to raw content URL
  const getRawUrl = (url: string): string | null => {
    if (!url) return null;

    // Handle GitHub URLs - support both edit and tree formats
    const githubEditRegex = /github\.com\/([^/]+)\/([^/]+)\/(edit|tree)\/([^/]+)\/(.+)/;
    const match = url.match(githubEditRegex);

    if (match) {
      const [, owner, repo, urlType, branch, path] = match;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    }

    // Handle GitLab URLs
    const gitlabEditRegex = /gitlab\.com\/([^/]+)\/([^/]+)\/-\/edit\/([^/]+)\/(.+)/;
    const gitlabMatch = url.match(gitlabEditRegex);

    if (gitlabMatch) {
      const [, owner, repo, branch, path] = gitlabMatch;
      return `https://gitlab.com/${owner}/${repo}/-/raw/${branch}/${path}`;
    }

    return url; // Return original URL if we can't convert it (for local development)
  };

  // Get content using the appropriate method
  const getContent = async (url: string): Promise<string> => {
    // For local development, try to fetch the content directly
    if (process.env.NODE_ENV === 'development' && !url.startsWith('http')) {
      try {
        // Try to fetch from location relative to the current page
        const localUrl = url.startsWith('/') ? url : `/${url}`;
        const response = await fetch(localUrl);
        if (response.ok) {
          return await response.text();
        }
      } catch (error) {
        console.error('Error fetching local content:', error);
      }

      // If local fetch fails, return placeholder message
      return '# Content not available locally\n\nThis feature works best when deployed to GitHub Pages.';
    }

    // For production or if local fetch fails, use the raw URL
    const rawUrl = getRawUrl(url);
    if (!rawUrl) {
      return '# Content not available\n\nCould not determine the source URL for this page.';
    }

    const response = await fetch(rawUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  };

  // Fetch markdown and copy to clipboard
  const copyPageAsMarkdown = async () => {
    const currentEditUrl = getEditUrl();
    if (!currentEditUrl) {
      console.error('Edit URL not available');
      return;
    }

    setIsLoading(true);

    try {
      const markdown = await getContent(currentEditUrl);
      await navigator.clipboard.writeText(markdown);
      setCopySuccess(true);
      setIsOpen(false);
    } catch (error) {
      console.error('Error fetching markdown:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Open the raw markdown in a new tab
  const viewAsMarkdown = async () => {
    const currentEditUrl = getEditUrl();
    if (!currentEditUrl) {
      return;
    }

    const rawUrl = getRawUrl(currentEditUrl);
    if (rawUrl) {
      // For local development, create a blob URL
      if (process.env.NODE_ENV === 'development' && !currentEditUrl.startsWith('http')) {
        try {
          const content = await getContent(currentEditUrl);
          const blob = new Blob([content], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
        } catch (error) {
          console.error('Error creating blob:', error);
        }
      } else {
        // For production
        window.open(rawUrl, '_blank');
      }
      setIsOpen(false);
    }
  };

  // Open the current page in ChatGPT
  const openInChatGPT = () => {
    const currentUrl = window.location.href;
    // Use the correct ChatGPT URL format
    const chatGptUrl = `https://chat.openai.com/?model=gpt-4&q=${encodeURIComponent(`Tell me about this page: ${currentUrl}`)}`;
    window.open(chatGptUrl, '_blank');
    setIsOpen(false);
  };

  // Check if we should show the button on this page
  const [showButton, setShowButton] = useState(false);

  useEffect(() => {
    if (isExcludedPath) {
      setShowButton(false);
      return;
    }

    // Need a small delay to ensure the DOM is updated after page navigation
    const timer = setTimeout(() => {
      // In development, check if we have editUrl configured
      if (process.env.NODE_ENV === 'development') {
        const hasEditUrl = !!getEditUrl();
        setShowButton(hasEditUrl);
      } else {
        // In production, check for the edit link in the DOM
        const hasEditLink = !!document.querySelector('a.theme-edit-this-page');
        setShowButton(hasEditLink);
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [location.pathname, isExcludedPath]);

  // Don't render the button if it shouldn't be shown
  if (!showButton) {
    return null;
  }

  return (
    <div className={styles.copyPageButtonContainer} ref={dropdownRef}>
      <button
        className={styles.copyPageButton}
        onClick={toggleDropdown}
        aria-label="Copy page"
        title="Copy page"
        disabled={isLoading}
      >
        <svg
          className={styles.copyIcon}
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span className={styles.copyPageButtonText}>Copy page</span>
        <svg
          className={styles.dropdownIcon}
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>

      {isOpen && (
        <div className={`${styles.dropdown} ${colorMode === 'dark' ? styles.dark : ''}`}>
          <div className={styles.dropdownHeader}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <div>
              <div className={styles.dropdownTitle}>Copy page</div>
              <div className={styles.dropdownSubtitle}>Copy this page as Markdown for LLMs</div>
            </div>
          </div>

          <button className={styles.dropdownItem} onClick={copyPageAsMarkdown} disabled={isLoading}>
            <svg
              className={styles.itemIcon}
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <div>
              <div className={styles.dropdownItemTitle}>Copy as Markdown</div>
              <div className={styles.dropdownItemSubtitle}>Copy to clipboard</div>
            </div>
          </button>

          <button className={styles.dropdownItem} onClick={viewAsMarkdown} disabled={isLoading}>
            <span className={styles.codeIcon}>{'</>'}</span>
            <div>
              <div className={styles.dropdownItemTitle}>
                View as Markdown <span className={styles.externalIcon}>↗</span>
              </div>
              <div className={styles.dropdownItemSubtitle}>View this page as plain text</div>
            </div>
          </button>

          <button className={styles.dropdownItem} onClick={openInChatGPT}>
            <svg className={styles.chatGptIcon} viewBox="0 0 24 24" width="20" height="20">
              <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.2" />
              <path d="M12 4v16M4 12h16" stroke="currentColor" strokeWidth="2" />
            </svg>
            <div>
              <div className={styles.dropdownItemTitle}>
                Open in ChatGPT <span className={styles.externalIcon}>↗</span>
              </div>
              <div className={styles.dropdownItemSubtitle}>Ask questions about this page</div>
            </div>
          </button>
        </div>
      )}

      {copySuccess && <div className={styles.copySuccessTooltip}>Copied to clipboard!</div>}

      {isLoading && <div className={styles.loadingTooltip}>Loading...</div>}
    </div>
  );
}

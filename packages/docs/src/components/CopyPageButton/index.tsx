import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from '@docusaurus/router';
import { useColorMode } from '@docusaurus/theme-common';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import styles from './styles.module.css';

// Define paths to exclude
const EXCLUDED_PATHS = [
  /^\/api\//, // Exclude API pages
  /^\/api\/?$/,
  /^\/packages\/?$/, // Exclude packages index
];

export default function CopyPageButton(): JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { colorMode } = useColorMode();
  const location = useLocation();
  const { siteConfig } = useDocusaurusContext();

  const isExcludedPath = EXCLUDED_PATHS.some((regex) => regex.test(location.pathname));

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

  useEffect(() => {
    if (copySuccess) {
      const timer = setTimeout(() => {
        setCopySuccess(false);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [copySuccess]);

  const toggleDropdown = () => {
    setIsOpen(!isOpen);
  };

  const getEditUrl = (): string | null => {
    const editLinkElement = document.querySelector('a.theme-edit-this-page');
    if (editLinkElement && editLinkElement.getAttribute('href')) {
      return editLinkElement.getAttribute('href');
    }
    if (process.env.NODE_ENV === 'development') {
      let editUrl = siteConfig.presets?.[0]?.[1]?.docs?.editUrl || siteConfig.themeConfig?.editUrl;
      if (editUrl) {
        if (editUrl.includes('/tree/')) {
          editUrl = editUrl.replace('/tree/', '/edit/');
        }
        const baseEditUrl = editUrl.endsWith('/') ? editUrl.slice(0, -1) : editUrl;
        let currentPath = location.pathname.replace(/^\//, '').replace(/\/$/, '');
        if (currentPath.startsWith('docs/')) {
          currentPath = currentPath.substring(5);
        }
        // For versioned docs, the path might already include the version and not need /docs prefix
        // It might also be nested, so we construct relative to packages/docs
        if (currentPath.match(/^\d+\.\d+\.\d+\//)) {
          // If it looks like a version path e.g. 0.25.9/guides
          return `${baseEditUrl}/${currentPath}.md`;
        }
        // Attempt to handle paths that might be directly in 'docs' or other top-level content folders
        if (editUrl.includes('packages/docs')) {
          return `${baseEditUrl}/${currentPath}.md`;
        }

        return `${baseEditUrl}/docs/${currentPath}.md`; // Default assumption
      }
    }
    return null;
  };

  const getRawUrl = (url: string): string | null => {
    if (!url) return null;
    const githubEditRegex = /github\.com\/([^/]+)\/([^/]+)\/(edit|tree)\/([^/]+)\/(.+)/;
    const match = url.match(githubEditRegex);
    if (match) {
      const [, owner, repo, , branch, path] = match;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    }
    const gitlabEditRegex = /gitlab\.com\/([^/]+)\/([^/]+)\/-\/edit\/([^/]+)\/(.+)/;
    const gitlabMatch = url.match(gitlabEditRegex);
    if (gitlabMatch) {
      const [, owner, repo, branch, path] = gitlabMatch;
      return `https://gitlab.com/${owner}/${repo}/-/raw/${branch}/${path}`;
    }
    return url;
  };

  const getContent = async (url: string): Promise<string> => {
    if (process.env.NODE_ENV === 'development' && !url.startsWith('http')) {
      try {
        const localUrl = url.startsWith('/') ? url : `/${url}`;
        const response = await fetch(localUrl);
        if (response.ok) return await response.text();
      } catch (error) {
        // console.error('Error fetching local content:', error);
      }
      return '# Content not available locally\n\nThis feature works best when deployed or when the file path is correctly resolved.';
    }
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

  const copyPageAsMarkdown = async () => {
    const currentEditUrl = getEditUrl();
    if (!currentEditUrl) {
      console.error('Edit URL not available for copying markdown.');
      alert('Could not determine the source file to copy.');
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
      alert(`Failed to fetch page content: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const viewAsMarkdown = async () => {
    const currentEditUrl = getEditUrl();
    if (!currentEditUrl) {
      alert('Could not determine the source file to view.');
      return;
    }
    const rawUrl = getRawUrl(currentEditUrl);
    if (rawUrl) {
      if (process.env.NODE_ENV === 'development' && !currentEditUrl.startsWith('http')) {
        try {
          const content = await getContent(currentEditUrl);
          const blob = new Blob([content], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
        } catch (error) {
          console.error('Error creating blob for local view:', error);
          alert(`Failed to load local content for viewing: ${error.message}`);
        }
      } else {
        window.open(rawUrl, '_blank');
      }
      setIsOpen(false);
    }
  };

  const openInChatGPT = () => {
    const currentUrl = window.location.href;
    const chatGptUrl = `https://chatgpt.com/?q=${encodeURIComponent(`Tell me about this page: ${currentUrl}`)}`;
    window.open(chatGptUrl, '_blank');
    setIsOpen(false);
  };

  const [showButton, setShowButton] = useState(false);

  useEffect(() => {
    if (isExcludedPath) {
      setShowButton(false);
      return;
    }
    const timer = setTimeout(() => {
      if (process.env.NODE_ENV === 'development') {
        setShowButton(!!getEditUrl());
      } else {
        setShowButton(!!document.querySelector('a.theme-edit-this-page'));
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [location.pathname, isExcludedPath, getEditUrl]); // Added getEditUrl to dependencies

  if (!showButton) {
    // Simplified condition, isExcludedPath is checked inside useEffect
    return null;
  }

  return (
    <div className={styles.copyPageButtonContainer} ref={dropdownRef}>
      <button
        className={styles.copyPageButton}
        onClick={toggleDropdown}
        aria-label="Content actions"
        title="Content actions"
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        <ClipboardIcon className={styles.copyIcon} />
        <span className={styles.copyPageButtonText}>Copy Page</span>
        <DropdownArrowIcon className={styles.dropdownIcon} />
      </button>

      {copySuccess && <div className={styles.copySuccessTooltip}>Copied to clipboard!</div>}
      {isLoading && <div className={styles.loadingTooltip}>Preparing content...</div>}

      {isOpen && (
        <div className={`${styles.dropdown} ${colorMode === 'dark' ? styles.dark : ''}`}>
          {/* Copy Page as Markdown */}
          <button className={styles.dropdownItem} onClick={copyPageAsMarkdown} disabled={isLoading}>
            <ClipboardIcon className={styles.itemIcon} />
            <div>
              <div className={styles.dropdownItemTitle}>Copy page as Markdown</div>
              <div className={styles.dropdownItemSubtitle}>
                Copies the full Markdown content to your clipboard.
              </div>
            </div>
          </button>

          {/* View as Markdown */}
          <button className={styles.dropdownItem} onClick={viewAsMarkdown}>
            <CodeIcon className={styles.itemIcon} />
            <div>
              <div className={styles.dropdownItemTitle}>
                View as Markdown <ExternalLinkIcon className={styles.externalIcon} />
              </div>
              <div className={styles.dropdownItemSubtitle}>
                Opens the raw Markdown file in a new tab.
              </div>
            </div>
          </button>

          {/* Open in ChatGPT */}
          <button className={styles.dropdownItem} onClick={openInChatGPT}>
            <ChatGptIcon className={styles.itemIcon} />
            <div>
              <div className={styles.dropdownItemTitle}>
                Open in ChatGPT <ExternalLinkIcon className={styles.externalIcon} />
              </div>
              <div className={styles.dropdownItemSubtitle}>
                Discuss this page with ChatGPT (opens new tab).
              </div>
            </div>
          </button>

          {/* Button to open llms-full.txt - MOVED TO THE END */}
          <button
            className={styles.dropdownItem}
            onClick={() => {
              window.open('/llms-full.txt', '_blank');
              setIsOpen(false);
            }}
          >
            <FileTextIcon className={styles.itemIcon} />
            <div>
              <div className={styles.dropdownItemTitle}>
                Open all docs (llms-full.txt) <ExternalLinkIcon className={styles.externalIcon} />
              </div>
              <div className={styles.dropdownItemSubtitle}>
                Opens the complete documentation context file.
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

// Helper components for icons
const InfoIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 20 20" fill="currentColor" width="24" height="24" {...props}>
    <path
      fillRule="evenodd"
      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
      clipRule="evenodd"
    />
  </svg>
);

const ClipboardIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20" {...props}>
    <path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z" />
    <path d="M3 5a2 2 0 012-2h10a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V5zm2 0h10v10H5V5z" />
  </svg>
);

const CodeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20" {...props}>
    <path
      fillRule="evenodd"
      d="M12.316 3.051a1 1 0 01.633 1.265l-4 12a1 1 0 11-1.898-.632l4-12a1 1 0 011.265-.633zM5.707 6.293a1 1 0 010 1.414L3.414 10l2.293 2.293a1 1 0 11-1.414 1.414l-3-3a1 1 0 010-1.414l3-3a1 1 0 011.414 0zm8.586 0a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 11-1.414-1.414L16.586 10l-2.293-2.293a1 1 0 010-1.414z"
      clipRule="evenodd"
    />
  </svg>
);

const ChatGptIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width="20"
    height="20"
    {...props}
    className={`${styles.chatGptIcon} ${props.className || ''}`}
  >
    <path d="M12.012 2.25c-5.028 0-9.38 3.646-9.38 8.625s4.34 8.628 9.38 8.628c1.998 0 3.916-.645 5.52-1.843l3.083 1.058-1.01-2.787c1.098-1.633 1.715-3.61 1.715-5.648s-4.353-8.625-9.398-8.625zm0 1.875c3.96 0 7.523 2.99 7.523 6.75s-3.563 6.75-7.523 6.75c-3.958 0-7.508-2.99-7.508-6.75s3.55-6.75 7.508-6.75z M9.38 8.625c-.693 0-1.252.56-1.252 1.25s.559 1.25 1.252 1.25c.692 0 1.25-.56 1.25-1.25s-.558-1.25-1.25-1.25zm5.248 0c-.692 0-1.25.56-1.25 1.25s.558 1.25 1.25 1.25c.693 0 1.252-.56 1.252-1.25s-.56-1.25-1.252-1.25z" />
  </svg>
);

const DropdownArrowIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" {...props}>
    <path
      fillRule="evenodd"
      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
      clipRule="evenodd"
    />
  </svg>
);

const ExternalLinkIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 20 20"
    fill="currentColor"
    width="12"
    height="12"
    {...props}
    className={styles.externalIcon}
  >
    <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
    <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
  </svg>
);

const FileTextIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20" {...props}>
    <path d="M4 4a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V8a2 2 0 00-2-2h-5L9 4H4zm2 6a1 1 0 100 2h8a1 1 0 100-2H6z" />
  </svg>
);

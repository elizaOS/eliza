import React, { useState, useCallback, useEffect, useRef } from 'react';
import { debounce } from 'lodash';
import { Search, Filter, Code, BookOpen, Zap, X, ArrowRight, Sparkles } from 'lucide-react';
import { useHistory } from '@docusaurus/router';
import { usePluginData } from '@docusaurus/useGlobalData';
import { useAIConfig, getAIProviderName } from '@site/src/utils/aiConfig';
import styles from './styles.module.css';

// Extend window object for search index
declare global {
  interface Window {
    lunr?: any;
    searchIndex?: any;
    searchDocuments?: Record<string, any>;
  }
}

interface SearchResult {
  id: string;
  title: string;
  content: string;
  url: string;
  type: 'doc' | 'api' | 'code' | 'package' | 'community';
  category: string;
  relevance: number;
  highlights: string[];
  tags: string[];
}

interface SearchSuggestion {
  id: string;
  text: string;
  type: 'query' | 'filter' | 'category';
  icon: React.ReactNode;
}

export default function SmartSearch(): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [selectedResult, setSelectedResult] = useState(-1);
  const [showResults, setShowResults] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const aiConfig = useAIConfig();
  const aiEnabled = aiConfig.enabled;
  const aiProvider = getAIProviderName(aiConfig.provider);

  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const history = useHistory();

  // Get search index data from Docusaurus
  const searchData = usePluginData('@docusaurus/plugin-content-docs');

  // Enhanced search categories with AI-powered suggestions
  const categories = [
    { id: 'all', label: 'All', icon: <Search size={16} /> },
    { id: 'doc', label: 'Documentation', icon: <BookOpen size={16} /> },
    { id: 'api', label: 'API Reference', icon: <Code size={16} /> },
    { id: 'package', label: 'Packages', icon: <Zap size={16} /> },
    { id: 'community', label: 'Blog & News', icon: <BookOpen size={16} /> },
  ];

  // AI-powered search suggestions based on context
  const generateSuggestions = useCallback(
    (searchTerm: string): SearchSuggestion[] => {
      const suggestions: SearchSuggestion[] = [];

      // Common patterns and intelligent suggestions
      const patterns = [
        {
          pattern: /agent|ai|eliza/i,
          suggestions: [
            {
              id: 'agent-setup',
              text: 'Agent Setup Guide',
              type: 'query' as const,
              icon: <Zap size={14} />,
            },
            {
              id: 'agent-config',
              text: 'Agent Configuration',
              type: 'query' as const,
              icon: <Code size={14} />,
            },
            {
              id: 'agent-memory',
              text: 'Agent Memory System',
              type: 'query' as const,
              icon: <BookOpen size={14} />,
            },
          ],
        },
        {
          pattern: /plugin|extend|custom/i,
          suggestions: [
            {
              id: 'plugin-dev',
              text: 'Plugin Development',
              type: 'query' as const,
              icon: <Code size={14} />,
            },
            {
              id: 'plugin-api',
              text: 'Plugin API Reference',
              type: 'query' as const,
              icon: <Code size={14} />,
            },
            {
              id: 'custom-actions',
              text: 'Custom Actions',
              type: 'query' as const,
              icon: <Zap size={14} />,
            },
          ],
        },
        {
          pattern: /install|setup|start|begin/i,
          suggestions: [
            {
              id: 'quick-start',
              text: 'Quick Start Guide',
              type: 'query' as const,
              icon: <BookOpen size={14} />,
            },
            {
              id: 'installation',
              text: 'Installation Guide',
              type: 'query' as const,
              icon: <BookOpen size={14} />,
            },
            {
              id: 'first-agent',
              text: 'Create Your First Agent',
              type: 'query' as const,
              icon: <Zap size={14} />,
            },
          ],
        },
        {
          pattern: /api|rest|endpoint/i,
          suggestions: [
            {
              id: 'api-docs',
              text: 'API Documentation',
              type: 'query' as const,
              icon: <Code size={14} />,
            },
            {
              id: 'rest-api',
              text: 'REST API Reference',
              type: 'query' as const,
              icon: <Code size={14} />,
            },
            {
              id: 'authentication',
              text: 'API Authentication',
              type: 'query' as const,
              icon: <Code size={14} />,
            },
          ],
        },
      ];

      // Add contextual suggestions based on search term
      patterns.forEach(({ pattern, suggestions: patternSuggestions }) => {
        if (pattern.test(searchTerm)) {
          suggestions.push(...patternSuggestions);
        }
      });

      // Add recent searches
      if (searchHistory.length > 0) {
        suggestions.push(
          ...searchHistory.slice(0, 3).map((term) => ({
            id: `history-${term}`,
            text: term,
            type: 'query' as const,
            icon: <Search size={14} />,
          }))
        );
      }

      return suggestions.slice(0, 8);
    },
    [searchHistory]
  );

  // Regular search using Lunr.js search index
  const performRegularSearch = useCallback(async (searchTerm: string) => {
    try {
      // Try to use Lunr search if available
      if (window.lunr && window.searchIndex) {
        const idx = window.lunr.Index.load(window.searchIndex);
        const searchResults = idx.search(searchTerm);

        return searchResults.map((result: any) => {
          const doc = window.searchDocuments?.[result.ref] || {};

          // Determine type and category based on URL
          let type: 'doc' | 'api' | 'code' | 'package' | 'community' = 'doc';
          let category = 'Documentation';

          if (doc.url?.includes('/blog/')) {
            type = 'community';
            category = 'Blog';
          } else if (doc.url?.includes('/news/')) {
            type = 'community';
            category = 'News';
          } else if (doc.url?.includes('/api/')) {
            type = 'api';
            category = 'API Reference';
          } else if (doc.url?.includes('/packages/')) {
            type = 'package';
            category = 'Packages';
          }

          return {
            id: result.ref,
            title: doc.title || 'Untitled',
            content: doc.content?.substring(0, 200) + '...' || '',
            url: doc.url || '#',
            type,
            category,
            relevance: result.score,
            highlights: [],
            tags: doc.tags || [],
          };
        });
      }

      // Fallback to simple search if Lunr not available
      const searchDocuments = window.searchDocuments || {};
      const results: SearchResult[] = [];

      Object.entries(searchDocuments).forEach(([id, doc]: [string, any]) => {
        const titleMatch = doc.title?.toLowerCase().includes(searchTerm.toLowerCase());
        const contentMatch = doc.content?.toLowerCase().includes(searchTerm.toLowerCase());

        if (titleMatch || contentMatch) {
          // Determine type and category based on URL
          let type: 'doc' | 'api' | 'code' | 'package' | 'community' = 'doc';
          let category = 'Documentation';

          if (doc.url?.includes('/blog/')) {
            type = 'community';
            category = 'Blog';
          } else if (doc.url?.includes('/news/')) {
            type = 'community';
            category = 'News';
          } else if (doc.url?.includes('/api/')) {
            type = 'api';
            category = 'API Reference';
          } else if (doc.url?.includes('/packages/')) {
            type = 'package';
            category = 'Packages';
          }

          results.push({
            id,
            title: doc.title || 'Untitled',
            content: doc.content?.substring(0, 200) + '...' || '',
            url: doc.url || '#',
            type,
            category,
            relevance: titleMatch ? 0.9 : 0.7,
            highlights: [],
            tags: doc.tags || [],
          });
        }
      });

      return results.sort((a, b) => b.relevance - a.relevance);
    } catch (error) {
      console.error('Search error:', error);
      return [];
    }
  }, []);

  // AI-enhanced search function
  const performAISearch = useCallback(
    async (searchTerm: string, regularResults: SearchResult[]) => {
      // In a real implementation, this would call an AI service
      // For now, we'll enhance the regular results with AI-like features

      // Generate semantic matches and suggestions
      const enhancedResults = regularResults.map((result) => ({
        ...result,
        relevance: result.relevance * 1.2, // Boost relevance with AI scoring
        highlights: extractHighlights(result.content, searchTerm),
      }));

      // Add AI-generated related content
      const aiSuggestions = generateAISuggestions(searchTerm, enhancedResults);

      return {
        results: enhancedResults,
        suggestions: aiSuggestions,
      };
    },
    []
  );

  // Extract highlights from content
  const extractHighlights = (content: string, searchTerm: string): string[] => {
    const words = searchTerm.toLowerCase().split(' ');
    const highlights: string[] = [];

    words.forEach((word) => {
      const index = content.toLowerCase().indexOf(word);
      if (index >= 0) {
        const start = Math.max(0, index - 20);
        const end = Math.min(content.length, index + word.length + 20);
        highlights.push('...' + content.substring(start, end) + '...');
      }
    });

    return highlights.slice(0, 3);
  };

  // Generate AI suggestions based on search context
  const generateAISuggestions = (
    searchTerm: string,
    results: SearchResult[]
  ): SearchSuggestion[] => {
    const suggestions: SearchSuggestion[] = [];

    // Add contextual suggestions based on results
    if (results.length > 0) {
      const topResult = results[0];
      if (topResult.type === 'doc') {
        suggestions.push({
          id: 'related-api',
          text: `View API docs for ${topResult.title}`,
          type: 'query',
          icon: <Code size={14} />,
        });
      }
    }

    // Add intelligent query refinements
    if (searchTerm.split(' ').length === 1) {
      suggestions.push({
        id: 'expand-query',
        text: `${searchTerm} tutorial`,
        type: 'query',
        icon: <BookOpen size={14} />,
      });
      suggestions.push({
        id: 'expand-api',
        text: `${searchTerm} API reference`,
        type: 'query',
        icon: <Code size={14} />,
      });
    }

    return suggestions;
  };

  // Main search function
  const performSearch = useCallback(
    async (searchTerm: string) => {
      if (!searchTerm.trim()) {
        setResults([]);
        setSuggestions([]);
        return;
      }

      setIsLoading(true);

      try {
        // First, perform regular search
        const regularResults = await performRegularSearch(searchTerm);

        if (aiEnabled) {
          // Enhance with AI if enabled
          const { results: aiResults, suggestions: aiSuggestions } = await performAISearch(
            searchTerm,
            regularResults
          );
          setResults(aiResults);
          setSuggestions([...generateSuggestions(searchTerm), ...aiSuggestions]);
        } else {
          // Use regular search results
          setResults(regularResults);
          setSuggestions(generateSuggestions(searchTerm));
        }

        // Update search history
        if (!searchHistory.includes(searchTerm)) {
          setSearchHistory((prev) => [searchTerm, ...prev.slice(0, 4)]);
        }
      } catch (error) {
        console.error('Search error:', error);
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    },
    [
      activeFilters,
      generateSuggestions,
      searchHistory,
      aiEnabled,
      performRegularSearch,
      performAISearch,
    ]
  );

  // Debounced search
  const debouncedSearch = useCallback(
    debounce((searchTerm: string) => {
      performSearch(searchTerm);
    }, 300),
    [performSearch]
  );

  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    setShowResults(true);
    debouncedSearch(value);
  };

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedResult((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedResult((prev) => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter') {
      if (selectedResult >= 0 && results[selectedResult]) {
        history.push(results[selectedResult].url);
        setShowResults(false);
        setQuery('');
      }
    } else if (e.key === 'Escape') {
      setShowResults(false);
      inputRef.current?.blur();
    }
  };

  // Handle result click
  const handleResultClick = (result: SearchResult) => {
    history.push(result.url);
    setShowResults(false);
    setQuery('');
  };

  // Handle suggestion click
  const handleSuggestionClick = (suggestion: SearchSuggestion) => {
    if (suggestion.type === 'query') {
      setQuery(suggestion.text);
      debouncedSearch(suggestion.text);
    } else if (suggestion.type === 'filter') {
      const filterId = suggestion.id.replace('filter-', '');
      setActiveFilters((prev) =>
        prev.includes(filterId) ? prev.filter((f) => f !== filterId) : [...prev, filterId]
      );
    }
  };

  // Handle filter toggle
  const toggleFilter = (filterId: string) => {
    setActiveFilters((prev) =>
      prev.includes(filterId) ? prev.filter((f) => f !== filterId) : [...prev, filterId]
    );
  };

  // Close results when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className={styles.smartSearch} ref={searchRef}>
      <div className={styles.searchContainer}>
        <div className={styles.searchInputWrapper}>
          <Search size={18} className={styles.searchIcon} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setShowResults(true)}
            placeholder={
              aiEnabled
                ? "AI-powered search... (try 'how to create an agent')"
                : 'Search documentation...'
            }
            className={styles.searchInput}
            aria-label={aiEnabled ? 'AI-powered smart search' : 'Search'}
            aria-expanded={showResults}
            aria-autocomplete="list"
          />
          {aiEnabled && (
            <div
              className={styles.aiIndicator}
              title={`AI-enhanced search powered by ${aiProvider}`}
            >
              <Sparkles size={16} />
            </div>
          )}
          {query && (
            <button
              className={styles.clearButton}
              onClick={() => {
                setQuery('');
                setResults([]);
                setSuggestions([]);
                setShowResults(false);
              }}
              aria-label="Clear search"
            >
              <X size={16} />
            </button>
          )}
          <button
            className={`${styles.filterButton} ${showFilters ? styles.active : ''}`}
            onClick={() => setShowFilters(!showFilters)}
            aria-label="Toggle filters"
          >
            <Filter size={16} />
          </button>
        </div>

        {/* Filter Bar */}
        {showFilters && (
          <div className={styles.filterBar}>
            {categories.map((category) => (
              <button
                key={category.id}
                className={`${styles.filterChip} ${activeFilters.includes(category.id) ? styles.active : ''}`}
                onClick={() => toggleFilter(category.id)}
              >
                {category.icon}
                {category.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Search Results */}
      {showResults && (query || suggestions.length > 0) && (
        <div className={styles.searchResults}>
          {isLoading && (
            <div className={styles.loadingState}>
              <div className={styles.loadingSpinner} />
              <span>Searching...</span>
            </div>
          )}

          {/* Suggestions */}
          {!isLoading && suggestions.length > 0 && (
            <div className={styles.suggestionsSection}>
              <div className={styles.sectionHeader}>
                {aiEnabled ? <Sparkles size={14} /> : <Zap size={14} />}
                <span>{aiEnabled ? 'AI-Powered Suggestions' : 'Suggestions'}</span>
              </div>
              <div className={styles.suggestions}>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    className={styles.suggestionItem}
                    onClick={() => handleSuggestionClick(suggestion)}
                  >
                    {suggestion.icon}
                    <span>{suggestion.text}</span>
                    <ArrowRight size={12} className={styles.suggestionArrow} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Results */}
          {!isLoading && results.length > 0 && (
            <div className={styles.resultsSection}>
              <div className={styles.sectionHeader}>
                <Search size={14} />
                <span>Results ({results.length})</span>
              </div>
              <div className={styles.results}>
                {results.map((result, index) => (
                  <button
                    key={result.id}
                    className={`${styles.resultItem} ${index === selectedResult ? styles.selected : ''}`}
                    onClick={() => handleResultClick(result)}
                  >
                    <div className={styles.resultHeader}>
                      <span className={styles.resultTitle}>{result.title}</span>
                      <span className={`${styles.resultType} ${styles[result.type]}`}>
                        {result.type.toUpperCase()}
                      </span>
                    </div>
                    <div className={styles.resultContent}>{result.content}</div>
                    <div className={styles.resultFooter}>
                      <span className={styles.resultCategory}>{result.category}</span>
                      <div className={styles.resultTags}>
                        {result.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className={styles.resultTag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* No Results */}
          {!isLoading && query && results.length === 0 && (
            <div className={styles.noResults}>
              <Search size={24} />
              <p>No results found for "{query}"</p>
              <p>Try different keywords or check out our suggestions above</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { debounce } from 'lodash';
import { Search, Filter, Code, BookOpen, Zap, X, ArrowRight, Sparkles } from 'lucide-react';
import { useHistory } from '@docusaurus/router';
import { usePluginData } from '@docusaurus/useGlobalData';
import { useAIConfig, getAIProviderName } from '../../utils/aiConfig';
import { getAISearchService } from '../../services/aiSearchService';
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

  // Enhanced semantic search using Lunr.js search index
  const performRegularSearch = useCallback(async (searchTerm: string) => {
    try {
      // Try to use Lunr search if available
      if (window.lunr && window.searchIndex) {
        const idx = window.lunr.Index.load(window.searchIndex);
        
        // Perform multiple search strategies for better semantic matching
        let searchResults = [];
        
        // 1. Exact phrase search
        try {
          searchResults = idx.search(`"${searchTerm}"`);
        } catch (e) {
          // If exact phrase fails, continue with other strategies
        }
        
        // 2. Fuzzy search with wildcards
        if (searchResults.length === 0) {
          const fuzzyTerm = searchTerm.split(' ').map(term => `${term}~1 ${term}*`).join(' ');
          searchResults = idx.search(fuzzyTerm);
        }
        
        // 3. Individual word search with OR
        if (searchResults.length === 0) {
          const orTerm = searchTerm.split(' ').join(' OR ');
          searchResults = idx.search(orTerm);
        }
        
        // 4. Broad match with stemming
        if (searchResults.length === 0) {
          searchResults = idx.search(searchTerm);
        }

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

  // AI-enhanced semantic search function
  const performAISearch = useCallback(
    async (searchTerm: string, regularResults: SearchResult[]) => {
      // Use AI search service if configured
      const aiSearchService = getAISearchService(
        aiConfig.provider,
        aiConfig.apiKey,
        window.searchIndex
      );

      if (aiSearchService && aiConfig.enabled) {
        try {
          console.log('AI Search enabled - Provider:', aiConfig.provider);
          console.log('Making AI-enhanced search for:', searchTerm);
          
          // Use real AI service for enhanced search
          const aiResponse = await aiSearchService.search({
            query: searchTerm,
            context: `Searching ElizaOS documentation for: ${searchTerm}`,
            maxResults: 10,
          });

          console.log('AI Search response received:', aiResponse);

          // Merge AI suggestions with generated suggestions
          const allSuggestions = [
            ...generateSuggestions(searchTerm),
            ...aiResponse.suggestions.map((text, idx) => ({
              id: `ai-suggestion-${idx}`,
              text,
              type: 'query' as const,
              icon: <Sparkles size={14} />,
            })),
          ];

          return {
            results: aiResponse.results,
            suggestions: allSuggestions.slice(0, 8),
          };
        } catch (error) {
          console.error('AI search failed, falling back to enhanced search:', error);
        }
      }

      // Fallback to client-side enhancement if AI service not available
      const enhancedResults = regularResults.map((result) => {
        // Calculate semantic relevance based on content analysis
        const semanticScore = calculateSemanticRelevance(result, searchTerm);
        
        // Extract contextual highlights showing where terms appear
        const contextualHighlights = extractSemanticHighlights(result.content, searchTerm);
        
        // Determine if this is a conceptual match even without exact terms
        const isConceptualMatch = detectConceptualMatch(result, searchTerm);
        
        return {
          ...result,
          relevance: result.relevance * semanticScore,
          highlights: contextualHighlights,
          isSemanticMatch: isConceptualMatch,
          semanticTags: extractSemanticTags(result, searchTerm),
        };
      });

      // Sort by semantic relevance
      enhancedResults.sort((a, b) => b.relevance - a.relevance);

      // Generate intelligent suggestions based on search intent
      const aiSuggestions = generateSemanticSuggestions(searchTerm, enhancedResults);

      return {
        results: enhancedResults,
        suggestions: aiSuggestions,
      };
    },
    [aiConfig, generateSuggestions]
  );

  // Calculate semantic relevance score
  const calculateSemanticRelevance = (result: SearchResult, searchTerm: string): number => {
    let score = 1.0;
    const terms = searchTerm.toLowerCase().split(' ');
    const content = (result.title + ' ' + result.content).toLowerCase();
    
    // Boost for title matches
    terms.forEach(term => {
      if (result.title.toLowerCase().includes(term)) score *= 1.5;
    });
    
    // Boost for multiple term matches
    const matchCount = terms.filter(term => content.includes(term)).length;
    score *= (1 + matchCount * 0.2);
    
    // Boost for semantic category matches
    if (searchTerm.includes('api') && result.type === 'api') score *= 1.3;
    if (searchTerm.includes('guide') && result.category.includes('Guide')) score *= 1.3;
    if (searchTerm.includes('example') && result.content.includes('example')) score *= 1.2;
    
    return Math.min(score, 2.0); // Cap at 2x boost
  };

  // Extract semantic highlights with context
  const extractSemanticHighlights = (content: string, searchTerm: string): string[] => {
    const words = searchTerm.toLowerCase().split(' ');
    const highlights: string[] = [];
    const sentences = content.split(/[.!?]+/);
    
    // Find sentences containing search terms
    sentences.forEach(sentence => {
      const lowerSentence = sentence.toLowerCase();
      if (words.some(word => lowerSentence.includes(word))) {
        highlights.push(sentence.trim());
      }
    });
    
    // Also find paragraphs with high keyword density
    const paragraphs = content.split('\n\n');
    paragraphs.forEach(para => {
      const matchCount = words.filter(word => para.toLowerCase().includes(word)).length;
      if (matchCount >= Math.ceil(words.length / 2) && para.length < 300) {
        highlights.push(para.trim());
      }
    });
    
    return [...new Set(highlights)].slice(0, 3);
  };

  // Detect conceptual matches
  const detectConceptualMatch = (result: SearchResult, searchTerm: string): boolean => {
    const concepts = {
      'getting started': ['quickstart', 'installation', 'setup', 'begin', 'first'],
      'authentication': ['auth', 'login', 'security', 'token', 'api key'],
      'deployment': ['deploy', 'production', 'hosting', 'server', 'docker'],
      'troubleshooting': ['error', 'problem', 'issue', 'fix', 'debug'],
      'performance': ['speed', 'optimize', 'fast', 'slow', 'cache'],
    };
    
    const searchLower = searchTerm.toLowerCase();
    const contentLower = (result.title + ' ' + result.content).toLowerCase();
    
    for (const [concept, keywords] of Object.entries(concepts)) {
      if (searchLower.includes(concept) || keywords.some(kw => searchLower.includes(kw))) {
        if (keywords.some(kw => contentLower.includes(kw))) {
          return true;
        }
      }
    }
    
    return false;
  };

  // Extract semantic tags
  const extractSemanticTags = (result: SearchResult, searchTerm: string): string[] => {
    const tags = [...result.tags];
    
    // Add inferred tags based on content
    if (result.content.includes('npm install') || result.content.includes('bun add')) {
      tags.push('installation');
    }
    if (result.content.includes('import') || result.content.includes('require')) {
      tags.push('code-example');
    }
    if (result.type === 'api') {
      tags.push('reference');
    }
    
    return [...new Set(tags)];
  };

  // Generate semantic suggestions
  const generateSemanticSuggestions = (searchTerm: string, results: SearchResult[]): SearchSuggestion[] => {
    const suggestions: SearchSuggestion[] = [];
    
    // Suggest related concepts
    if (searchTerm.includes('install')) {
      suggestions.push({
        id: 'setup-guide',
        text: 'Complete setup guide',
        type: 'query',
        icon: <BookOpen size={14} />,
      });
    }
    
    // Suggest based on result patterns
    if (results.length > 0 && results[0].type === 'api') {
      suggestions.push({
        id: 'code-examples',
        text: `Code examples for ${searchTerm}`,
        type: 'query',
        icon: <Code size={14} />,
      });
    }
    
    // Suggest clarifications
    if (searchTerm.split(' ').length === 1) {
      suggestions.push({
        id: 'tutorial',
        text: `${searchTerm} tutorial`,
        type: 'query',
        icon: <BookOpen size={14} />,
      });
    }
    
    return suggestions.slice(0, 5);
  };

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

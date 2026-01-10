/**
 * Codebase Analysis Module
 * 
 * This module provides utilities for analyzing and understanding code structure,
 * dependencies, and metrics about a codebase.
 */

import {
  analyzeCodebase,
  FileInfo,
  DependencyInfo,
  ProjectStructure,
  analyzeProjectDependencies,
  findFilesByContent
} from './analyzer.js';

export {
  analyzeCodebase,
  FileInfo,
  DependencyInfo,
  ProjectStructure,
  analyzeProjectDependencies,
  findFilesByContent
};

/**
 * Analyze a codebase and return a summary of its structure
 * 
 * @param directoryPath - Path to the directory to analyze
 * @param options - Analysis options
 * @returns Promise resolving to the project structure
 */
export async function analyzeProject(
  directoryPath: string,
  options: {
    ignorePatterns?: string[];
    maxFiles?: number;
    maxSizePerFile?: number;
  } = {}
): Promise<ProjectStructure> {
  return analyzeCodebase(directoryPath, options);
}

/**
 * Background analysis state
 */
interface BackgroundAnalysisState {
  running: boolean;
  interval: NodeJS.Timeout | null;
  lastResults: ProjectStructure | null;
  workingDirectory: string | null;
}

// Background analysis state
const backgroundAnalysis: BackgroundAnalysisState = {
  running: false,
  interval: null,
  lastResults: null,
  workingDirectory: null
};

/**
 * Initialize the codebase analysis subsystem
 * 
 * @param config Configuration options for the codebase analysis
 * @returns The initialized codebase analysis system
 */
export function initCodebaseAnalysis(config: any = {}) {
  const analysisConfig = config.codebase || {};
  
  return {
    /**
     * Analyze the current working directory
     */
    analyzeCurrentDirectory: async (options = {}) => {
      const cwd = process.cwd();
      return analyzeCodebase(cwd, {
        ...analysisConfig,
        ...options
      });
    },
    
    /**
     * Analyze a specific directory
     */
    analyzeDirectory: async (directoryPath: string, options = {}) => {
      return analyzeCodebase(directoryPath, {
        ...analysisConfig,
        ...options
      });
    },
    
    /**
     * Find files by content pattern
     */
    findFiles: async (pattern: string, directoryPath: string = process.cwd(), options = {}) => {
      return findFilesByContent(pattern, directoryPath, options);
    },
    
    /**
     * Analyze project dependencies
     */
    analyzeDependencies: async (directoryPath: string = process.cwd()) => {
      return analyzeProjectDependencies(directoryPath);
    },
    
    /**
     * Start background analysis of the current directory
     */
    startBackgroundAnalysis: (interval = 5 * 60 * 1000) => { // Default: 5 minutes
      if (backgroundAnalysis.running) {
        return;
      }
      
      backgroundAnalysis.running = true;
      backgroundAnalysis.workingDirectory = process.cwd();
      
      // Perform initial analysis
      analyzeCodebase(backgroundAnalysis.workingDirectory, analysisConfig)
        .then(results => {
          backgroundAnalysis.lastResults = results;
        })
        .catch(err => {
          console.error('Background analysis error:', err);
        });
      
      // Set up interval for periodic re-analysis
      backgroundAnalysis.interval = setInterval(() => {
        if (!backgroundAnalysis.running || !backgroundAnalysis.workingDirectory) {
          return;
        }
        
        analyzeCodebase(backgroundAnalysis.workingDirectory, analysisConfig)
          .then(results => {
            backgroundAnalysis.lastResults = results;
          })
          .catch(err => {
            console.error('Background analysis error:', err);
          });
      }, interval);
    },
    
    /**
     * Stop background analysis
     */
    stopBackgroundAnalysis: () => {
      if (!backgroundAnalysis.running) {
        return;
      }
      
      if (backgroundAnalysis.interval) {
        clearInterval(backgroundAnalysis.interval);
        backgroundAnalysis.interval = null;
      }
      
      backgroundAnalysis.running = false;
    },
    
    /**
     * Get the latest background analysis results
     */
    getBackgroundAnalysisResults: () => {
      return backgroundAnalysis.lastResults;
    }
  };
} 
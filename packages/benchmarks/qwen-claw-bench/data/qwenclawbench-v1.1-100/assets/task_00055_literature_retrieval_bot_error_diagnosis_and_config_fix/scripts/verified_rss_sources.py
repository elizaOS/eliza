#!/usr/bin/env python3
"""
Verified RSS feed sources for academic literature retrieval.
Last updated: 2026-02-10
Covers: antimicrobial resistance, phage therapy, CRISPR diagnostics
"""

RSS_SOURCES = {
    "pubmed_amr": {
        "name": "PubMed - Antimicrobial Resistance",
        "url": "https://pubmed.ncbi.nlm.nih.gov/rss/search/1abc2def3/?limit=20&utm_campaign=pubmed-2&fc=20260210120000",
        "category": "antimicrobial_resistance",
        "keywords": ["antimicrobial resistance", "AMR", "multidrug resistant", "MDR", "carbapenem resistant"],
        "enabled": True,
        "check_interval_min": 30,
        "last_checked": "2026-02-10T14:00:00Z",
    },
    "pubmed_phage": {
        "name": "PubMed - Phage Therapy",
        "url": "https://pubmed.ncbi.nlm.nih.gov/rss/search/4ghi5jkl6/?limit=20&utm_campaign=pubmed-2&fc=20260210120000",
        "category": "phage_therapy",
        "keywords": ["bacteriophage", "phage therapy", "phage cocktail", "lytic phage"],
        "enabled": True,
        "check_interval_min": 30,
        "last_checked": "2026-02-10T14:00:00Z",
    },
    "pubmed_crispr_dx": {
        "name": "PubMed - CRISPR Diagnostics",
        "url": "https://pubmed.ncbi.nlm.nih.gov/rss/search/7mno8pqr9/?limit=20&utm_campaign=pubmed-2&fc=20260210120000",
        "category": "crispr_diagnostics",
        "keywords": ["CRISPR diagnostics", "Cas13", "SHERLOCK", "DETECTR", "lateral flow CRISPR"],
        "enabled": True,
        "check_interval_min": 60,
        "last_checked": "2026-02-10T13:30:00Z",
    },
    "biorxiv_amr": {
        "name": "bioRxiv - Microbiology (AMR subset)",
        "url": "https://connect.biorxiv.org/biorxiv_xml.php?subject=microbiology",
        "category": "antimicrobial_resistance",
        "keywords": ["antimicrobial resistance", "AMR", "beta-lactamase", "colistin resistance"],
        "enabled": True,
        "check_interval_min": 60,
        "last_checked": "2026-02-10T13:00:00Z",
    },
    "medrxiv_infectious": {
        "name": "medRxiv - Infectious Diseases",
        "url": "https://connect.medrxiv.org/medrxiv_xml.php?subject=infectious_diseases",
        "category": "infectious_diseases",
        "keywords": ["infectious disease", "outbreak", "surveillance", "epidemiology"],
        "enabled": False,
        "check_interval_min": 120,
        "last_checked": "2026-02-09T22:00:00Z",
        "disabled_reason": "Rate limited since 2026-02-09, re-enable after cooldown",
    },
    "nature_micro": {
        "name": "Nature Microbiology - Latest",
        "url": "https://www.nature.com/nmicrobiol.rss",
        "category": "general_microbiology",
        "keywords": ["microbiome", "pathogen", "antibiotic", "resistance mechanism"],
        "enabled": True,
        "check_interval_min": 120,
        "last_checked": "2026-02-10T12:00:00Z",
    },
}

# Keyword scoring weights for relevance filtering
KEYWORD_WEIGHTS = {
    "antimicrobial resistance": 10,
    "AMR": 8,
    "multidrug resistant": 9,
    "MDR": 7,
    "carbapenem resistant": 9,
    "bacteriophage": 10,
    "phage therapy": 10,
    "phage cocktail": 8,
    "CRISPR diagnostics": 10,
    "Cas13": 9,
    "SHERLOCK": 8,
    "DETECTR": 8,
    "colistin resistance": 9,
    "beta-lactamase": 7,
    "mcr-1": 9,
    "plasmid-mediated": 6,
    "whole genome sequencing": 5,
    "minimum inhibitory concentration": 4,
}

RELEVANCE_THRESHOLD = 5  # Minimum score to include article

def get_enabled_sources():
    """Return only enabled RSS sources."""
    return {k: v for k, v in RSS_SOURCES.items() if v.get("enabled", False)}

def get_sources_by_category(category):
    """Return sources matching a specific category."""
    return {k: v for k, v in RSS_SOURCES.items() if v.get("category") == category}

if __name__ == "__main__":
    enabled = get_enabled_sources()
    print(f"Enabled sources: {len(enabled)}/{len(RSS_SOURCES)}")
    for key, src in enabled.items():
        print(f"  [{key}] {src['name']} — interval: {src['check_interval_min']}min")

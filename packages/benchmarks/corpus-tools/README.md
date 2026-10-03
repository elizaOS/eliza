# corpus-tools fixtures

Bundled synthetic LifeOps corpus sample (`fixtures/synthetic/`) consumed by
`suites/lifeops-bench/eliza_lifeops_bench/lifeworld/corpus.py` in its default
`sample` load mode; the hash-pinned tests in
`suites/lifeops-bench/tests/test_corpus_world.py` gate its contents. The data
is fully synthetic (see `fixtures/synthetic/manifest.json`); the real corpus
lives in the private `elizaos/private-lifeops-corpus` HF dataset (`huggingface`
mode). The corpus-tools importer/mapper package itself was retired in the
elizaOS monorepo — only these fixtures remain load-bearing.

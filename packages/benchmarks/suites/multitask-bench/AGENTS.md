# MultitaskBench — Agent Guide

Concurrency-interference benchmark: one long-lived agent drives N interleaved LifeOps tasks (N=1/5/10) and the headline metric is the per-task score delta at N versus the N=1 baseline over identical `(scenario, seed)` pairs.

Build, test, and setup: [README.md](README.md).

echo "Setting up misc webshop environment with conda..."
conda install mkl
conda install -c conda-forge faiss-cpu
conda install -c conda-forge openjdk=11

python -m spacy download en_core_web_sm
echo "Preprocessing webshop dataset..."
python gem/envs/webshop/preprocess.py
echo "Indexing webshop dataset for search engine..."
python -m pyserini.index.lucene \
    --collection JsonCollection \
    --input .cache/webshop/resources \
    --index .cache/webshop/indexes \
    --generator DefaultLuceneDocumentGenerator \
    --threads 1 \
    --storePositions --storeDocvectors --storeRaw
echo 'indexes saved at .cache/webshop/indexes'
echo "Setup complete."

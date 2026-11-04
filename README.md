# Census website

The website of the [census of elliptic and quasielliptic K3 surfaces over F2](https://github.com/Census-of-elliptic-fibrations/Census-of-elliptic-and-quasi-elliptic-K3-surfaces-over-F2). This is a preview: the data is incomplete, so please do not cite it yet.

It is a static site. Searches run in the visitor's browser with [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm), reading the Parquet files in `data/`.

## Try it locally

```
node tools/serve.mjs
```

Then open <http://localhost:8080/>. It needs an internet connection the first time, to fetch the search engine.

## Updating the data

The files in `data/` and `js/census_math.mjs` are generated. To rebuild them, run this in the census repository:

```
cd tools && npm install && cd ..
node tools/build_site_data.mjs <census.csv> <path to this folder>
```

The build stops if a row fails its checks.

## Layout

- `index.html`, `css/site.css`, `js/app.js`: the site.
- `js/census_math.mjs`: keys, fibres and the factors of P2; a copy from the census repository.
- `data/surfaces.parquet`, `data/fibres.parquet`: what the search reads.
- `data/rows/`: 1000 surfaces per file, with the L-function, for browsing and surface pages.
- `vendor/katex/`: KaTeX 0.16.11, for the mathematics.
- `js/magma-highlight.mjs`, `vendor/tree-sitter/`: Magma syntax highlighting, loaded on surface pages. Parser versions and rebuild instructions are in `vendor/tree-sitter/README.md`.

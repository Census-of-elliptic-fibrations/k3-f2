# Magma highlighting assets

These files are served locally and loaded only when a surface page displays a
Magma snippet. Hosting the site requires no build step or third-party requests
for highlighting.

- `tree-sitter.js` and `tree-sitter.wasm`: the unmodified browser runtime from
  [web-tree-sitter 0.25.10](https://www.npmjs.com/package/web-tree-sitter/v/0.25.10).
  Its MIT license is in `LICENSE.web-tree-sitter`.
- `tree-sitter-magma.wasm` and `highlights.scm`: the parser and unmodified queries
  from [tree-sitter-magma at 75b31f4](https://github.com/edgarcosta/tree-sitter-magma/tree/75b31f4695261967c7aa87d552d69805dc03c77b).
  Its MIT license is in `LICENSE.tree-sitter-magma`.

The parser was compiled from the committed generated source with Tree-sitter CLI
0.25.10 and Emscripten 6.0.9. Keep the grammar and query at the same revision when
updating them. The site's colours are defined in `css/site.css`; capture handling
and loading are in `js/magma-highlight.mjs`.

## Rebuild

With Node.js, Tree-sitter CLI 0.25.10, Emscripten and Git installed, run from the
site root. Use a fresh build directory if repeating the clone.

```sh
mkdir -p .build/highlighting
npm pack web-tree-sitter@0.25.10 --pack-destination .build/highlighting
tar -xf .build/highlighting/web-tree-sitter-0.25.10.tgz -C .build/highlighting
cp .build/highlighting/package/tree-sitter.js .build/highlighting/package/tree-sitter.wasm vendor/tree-sitter/
cp .build/highlighting/package/LICENSE vendor/tree-sitter/LICENSE.web-tree-sitter

git clone https://github.com/edgarcosta/tree-sitter-magma.git .build/highlighting/grammar
git -C .build/highlighting/grammar checkout 75b31f4695261967c7aa87d552d69805dc03c77b
(cd .build/highlighting/grammar && tree-sitter build --wasm)
cp .build/highlighting/grammar/tree-sitter-magma.wasm .build/highlighting/grammar/queries/highlights.scm vendor/tree-sitter/
cp .build/highlighting/grammar/LICENSE vendor/tree-sitter/LICENSE.tree-sitter-magma
```

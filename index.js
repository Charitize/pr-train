#!/usr/bin/env node

// This wrapper allows us to include a shebang since we won't compile this
// wrapper script, instead just calling the compiled package.
require('./dist/index.js');

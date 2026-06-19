# Constants - Commonly Used Commands
TEST_XVFB_PREFIX = 'xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99"'
XVFB_DEPS = [
    "python3",
    "python3-pip",
    "xvfb",
    "x11-xkb-utils",
    "xfonts-100dpi",
    "xfonts-75dpi",
    "xfonts-scalable",
    "xfonts-cyrillic",
    "x11-apps",
    "firefox",
]
X11_DEPS = [
    "libx11-xcb1",
    "libxcomposite1",
    "libxcursor1",
    "libxdamage1",
    "libxi6",
    "libxtst6",
    "libnss3",
    "libcups2",
    "libxss1",
    "libxrandr2",
    "libasound2",
    "libatk1.0-0",
    "libgtk-3-0",
    "x11-utils",
]

# Constants - Task Instance Installation Environment
SPECS_CALYPSO = {
    **{
        k: {
            "apt-pkgs": ["libsass-dev", "sassc"],
            "install": ["npm install --unsafe-perm"],
            "test_cmd": "npm run test-client",
            "docker_specs": {
                "node_version": k,
            },
        }
        for k in [
            "0.8",
            "4.2.3",
            "4.3.0",
            "5.10.1",
            "5.11.1",
            "6.1.0",
            "6.7.0",
            "6.9.0",
            "6.9.1",
            "6.9.4",
            "6.10.0",
            "6.10.2",
            "6.10.3",
            "6.11.1",
            "6.11.2",
            "6.11.5",
            "8.9.1",
            "8.9.3",
            "8.9.4",
            "8.11.0",
            "8.11.2",
            "10.4.1",
            "10.5.0",
            "10.6.0",
            "10.9.0",
            "10.10.0",
            "10.12.0",
            "10.13.0",
            "10.14.0",
            "10.15.2",
            "10.16.3",
        ]
    }
}

TEST_CHART_JS_TEMPLATE = "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start {} --single-run --coverage --grep --auto-watch false"
SPECS_CHART_JS = {
    **{
        k: {
            "install": [
                "pnpm install",
                "pnpm run build",
            ],
            "test_cmd": [
                "pnpm install",
                "pnpm run build",
                f'{TEST_XVFB_PREFIX} su chromeuser -c "{TEST_CHART_JS_TEMPLATE.format("./karma.conf.cjs")}"',
            ],
            "docker_specs": {
                "node_version": "21.6.2",
                "pnpm_version": "7.9.0",
                "run_args": {
                    "cap_add": ["SYS_ADMIN"],
                },
            },
        }
        for k in ["4.0", "4.1", "4.2", "4.3", "4.4"]
    },
    **{
        k: {
            "install": ["npm install"],
            "test_cmd": [
                "npm install",
                "npm run build",
                f'{TEST_XVFB_PREFIX} su chromeuser -c "{TEST_CHART_JS_TEMPLATE.format("./karma.conf.js")}"',
            ],
            "docker_specs": {
                "node_version": "21.6.2",
                "run_args": {
                    "cap_add": ["SYS_ADMIN"],
                },
            },
        }
        for k in ["3.0", "3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8"]
    },
    **{
        k: {
            "install": ["npm install", "npm install -g gulp-cli"],
            "test_cmd": [
                "npm install",
                "gulp build",
                TEST_XVFB_PREFIX + ' su chromeuser -c "gulp test"',
            ],
            "docker_specs": {
                "node_version": "21.6.2",
                "run_args": {
                    "cap_add": ["SYS_ADMIN"],
                },
            },
        }
        for k in ["2.0", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.9"]
    },
}
for v in SPECS_CHART_JS.keys():
    SPECS_CHART_JS[v]["apt-pkgs"] = XVFB_DEPS

SPECS_MARKED = {
    **{
        k: {
            "install": ["npm install"],
            "test_cmd": "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
            "docker_specs": {
                "node_version": "12.22.12",
            },
        }
        for k in [
            "0.3",
            "0.5",
            "0.6",
            "0.7",
            "1.0",
            "1.1",
            "1.2",
            "2.0",
            "3.9",
            "4.0",
            "4.1",
            "5.0",
        ]
    }
}
for v in ["4.0", "4.1", "5.0"]:
    SPECS_MARKED[v]["docker_specs"]["node_version"] = "20.16.0"

SPECS_P5_JS = {
    **{
        k: {
            "apt-pkgs": X11_DEPS,
            "install": [
                "npm install",
                "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js",
                "./node_modules/.bin/grunt yui",
            ],
            "test_cmd": (
                """sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\n"""
                "stdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force"
            ),
            "docker_specs": {
                "node_version": "14.17.3",
            },
        }
        for k in [
            "0.10",
            "0.2",
            "0.4",
            "0.5",
            "0.6",
            "0.7",
            "0.8",
            "0.9",
            "1.0",
            "1.1",
            "1.2",
            "1.3",
            "1.4",
            "1.5",
            "1.6",
            "1.7",
            "1.8",
            "1.9",
        ]
    },
}
for k in [
    "0.4",
    "0.5",
    "0.6",
]:
    SPECS_P5_JS[k]["install"] = [
        "npm install",
        "./node_modules/.bin/grunt yui",
    ]

SPECS_REACT_PDF = {
    **{
        k: {
            "apt-pkgs": [
                "pkg-config",
                "build-essential",
                "libpixman-1-0",
                "libpixman-1-dev",
                "libcairo2-dev",
                "libpango1.0-dev",
                "libjpeg-dev",
                "libgif-dev",
                "librsvg2-dev",
            ]
            + X11_DEPS,
            "install": ["npm i -g yarn", "yarn install"],
            "test_cmd": 'NODE_OPTIONS="--experimental-vm-modules" ./node_modules/.bin/jest --no-color',
            "docker_specs": {"node_version": "18.20.4"},
        }
        for k in ["1.0", "1.1", "1.2", "2.0"]
    }
}
for v in ["1.0", "1.1", "1.2"]:
    SPECS_REACT_PDF[v]["docker_specs"]["node_version"] = "8.17.0"
    SPECS_REACT_PDF[v]["install"] = ["npm install", "npm install cheerio@1.0.0-rc.3"]
    SPECS_REACT_PDF[v]["test_cmd"] = "./node_modules/.bin/jest --no-color"


JEST_JSON_JQ_TRANSFORM = """jq -r '.testResults[].assertionResults[] | "[" + (.status | ascii_upcase) + "] " + ((.ancestorTitles | join(" > ")) + (if .ancestorTitles | length > 0 then " > " else "" end) + .title)'"""

SPECS_BABEL = {
    "14532": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": ["yarn jest babel-generator --verbose"],
        "install": ["make bootstrap"],
        "build": ["make build"],
    },
    "13928": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": ['yarn jest babel-parser -t "arrow" --verbose'],
        "install": ["make bootstrap"],
        "build": ["make build"],
    },
    "15649": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": ["yarn jest packages/babel-traverse/test/scope.js --verbose"],
        "install": ["make bootstrap"],
        "build": ["make build"],
    },
    "15445": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": [
            'yarn jest packages/babel-generator/test/index.js -t "generation " --verbose'
        ],
        "install": ["make bootstrap"],
        "build": ["make build"],
    },
    "16130": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": ["yarn jest babel-helpers --verbose"],
        "install": ["make bootstrap"],
        "build": ["make build"],
    },
}

SPECS_VUEJS = {
    "11899": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": [
            "pnpm run test packages/compiler-sfc/__tests__/compileStyle.spec.ts --no-watch --reporter=verbose"
        ],
        "install": ["pnpm i"],
        "build": ["pnpm run build compiler-sfc"],
    },
    "11870": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": [
            "pnpm run test packages/runtime-core/__tests__/helpers/renderList.spec.ts --no-watch --reporter=verbose"
        ],
        "install": ["pnpm i"],
    },
    "11739": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": [
            'pnpm run test packages/runtime-core/__tests__/hydration.spec.ts --no-watch --reporter=verbose -t "mismatch handling"'
        ],
        "install": ["pnpm i"],
    },
    "11915": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": [
            'pnpm run test packages/compiler-core/__tests__/parse.spec.ts --no-watch --reporter=verbose -t "Element"'
        ],
        "install": ["pnpm i"],
    },
    "11589": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "test_cmd": [
            "pnpm run test packages/runtime-core/__tests__/apiWatch.spec.ts --no-watch --reporter=verbose"
        ],
        "install": ["pnpm i"],
    },
}

SPECS_DOCUSAURUS = {
    "10309": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["yarn install"],
        "test_cmd": [
            "yarn test packages/docusaurus-plugin-content-docs/src/client/__tests__/docsClientUtils.test.ts --verbose"
        ],
    },
    "10130": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["yarn install"],
        "test_cmd": [
            "yarn test packages/docusaurus/src/server/__tests__/brokenLinks.test.ts --verbose"
        ],
    },
    "9897": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["yarn install"],
        "test_cmd": [
            "yarn test packages/docusaurus-utils/src/__tests__/markdownUtils.test.ts --verbose"
        ],
    },
    "9183": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["yarn install"],
        "test_cmd": [
            "yarn test packages/docusaurus-theme-classic/src/__tests__/options.test.ts --verbose"
        ],
    },
    "8927": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["yarn install"],
        "test_cmd": [
            "yarn test packages/docusaurus-utils/src/__tests__/markdownLinks.test.ts --verbose"
        ],
    },
}

SPECS_IMMUTABLEJS = {
    "2006": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "build": ["npm run build"],
        "test_cmd": ["npx jest __tests__/Range.ts --verbose"],
    },
    "2005": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "build": ["npm run build"],
        "test_cmd": [
            f"npx jest __tests__/OrderedMap.ts __tests__/OrderedSet.ts --silent --json | {JEST_JSON_JQ_TRANSFORM}"
        ],
    },
}

SPECS_THREEJS = {
    "27395": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        # --ignore-scripts is used to avoid downloading chrome for puppeteer
        "install": ["npm install --ignore-scripts"],
        "test_cmd": ["npx qunit test/unit/src/math/Sphere.tests.js"],
    },
    "26589": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install --ignore-scripts"],
        "test_cmd": [
            "npx qunit test/unit/src/objects/Line.tests.js test/unit/src/objects/Mesh.tests.js test/unit/src/objects/Points.tests.js"
        ],
    },
    "25687": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install --ignore-scripts"],
        "test_cmd": [
            'npx qunit test/unit/src/core/Object3D.tests.js -f "/json|clone|copy/i"'
        ],
    },
}

SPECS_PREACT = {
    "4152": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/components.test.js"'
        ],
    },
    "4316": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/events.test.js"'
        ],
    },
    "4245": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/useId.test.js"'
        ],
    },
    "4182": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/errorBoundary.test.js"'
        ],
    },
    "4436": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/refs.test.js"'
        ],
    },
    "3763": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/lifecycles/componentDidMount.test.js"'
        ],
    },
    "3739": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/useState.test.js"',
        ],
    },
    "3689": {
        "docker_specs": {"node_version": "18", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/errorBoundary.test.js"',
        ],
    },
    "3567": {
        "docker_specs": {"node_version": "18", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/useEffect.test.js"',
        ],
    },
    "3562": {
        "docker_specs": {"node_version": "18", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="compat/test/browser/render.test.js"',
        ],
    },
    "3454": {
        "docker_specs": {"node_version": "18", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/svg.test.js"',
        ],
    },
    "3345": {
        "docker_specs": {"node_version": "18", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/useEffect.test.js"',
        ],
    },
    "3062": {
        "docker_specs": {"node_version": "16", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/render.test.js"',
        ],
    },
    "3010": {
        "docker_specs": {"node_version": "16", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/render.test.js"',
        ],
    },
    "2927": {
        "docker_specs": {"node_version": "16", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/render.test.js"',
        ],
    },
    "2896": {
        "docker_specs": {"node_version": "16", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="compat/test/browser/memo.test.js"',
        ],
    },
    "2757": {
        "docker_specs": {"node_version": "16", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": [
            'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/render.test.js"',
        ],
    },
}

SPECS_AXIOS = {
    "5892": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": ["npx mocha test/unit/adapters/http.js -R tap -g 'compression'"],
    },
    "5316": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        # Patch involves adding a new dependency, so we need to re-install
        "build": ["npm install"],
        "test_cmd": ["npx mocha test/unit/adapters/http.js -R tap -g 'FormData'"],
    },
    "4738": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        # Tests get stuck for some reason, so we run them with a timeout
        "test_cmd": [
            "timeout 10s npx mocha -R tap test/unit/adapters/http.js -g 'timeout'"
        ],
    },
    "4731": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": ["npx mocha -R tap test/unit/adapters/http.js -g 'body length'"],
    },
    "6539": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": ["npx mocha -R tap test/unit/regression/SNYK-JS-AXIOS-7361793.js"],
    },
    "5085": {
        "docker_specs": {"node_version": "20", "_variant": "js_2"},
        "install": ["npm install"],
        "test_cmd": ["npx mocha -R tap test/unit/regression/bugs.js"],
    },
}


MAP_REPO_VERSION_TO_SPECS_JS = {
    "Automattic/wp-calypso": SPECS_CALYPSO,
    "chartjs/Chart.js": SPECS_CHART_JS,
    "markedjs/marked": SPECS_MARKED,
    "processing/p5.js": SPECS_P5_JS,
    "diegomura/react-pdf": SPECS_REACT_PDF,
    "babel/babel": SPECS_BABEL,
    "vuejs/core": SPECS_VUEJS,
    "facebook/docusaurus": SPECS_DOCUSAURUS,
    "immutable-js/immutable-js": SPECS_IMMUTABLEJS,
    "mrdoob/three.js": SPECS_THREEJS,
    "preactjs/preact": SPECS_PREACT,
    "axios/axios": SPECS_AXIOS,
}

# Constants - Repository Specific Installation Instructions
MAP_REPO_TO_INSTALL_JS = {}

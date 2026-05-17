from typing import List
import shlex


def make_lombok_pre_install_script(tests: List[str]) -> List[str]:
    """
    There's no way to run individual tests out of the box, so this script
    modifies the xml file that defines test scripts to run individual tests with
    `ant test.instance`.
    """
    tests_xml = "\n".join(rf'<test name="{test}" />' for test in tests)
    xml = rf"""
    <target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">
      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">
        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />
        <classpath location="build/ant" />
        <classpath refid="cp.test" />
        <classpath refid="cp.stripe" />
        <classpath refid="packing.basedirs.path" />
        <classpath location="build/tests" />
        <classpath location="build/teststubs" />
        {tests_xml}
      </junit>
    </target>
    """
    build_file = "buildScripts/tests.ant.xml"
    escaped_xml = shlex.quote(xml.strip())

    return [
        f"{{ head -n -1 {build_file}; echo {escaped_xml}; tail -n 1 {build_file}; }} > temp_file && mv temp_file {build_file}"
    ]


def make_lucene_pre_install_script() -> List[str]:
    """
    This script modifies the gradle config to print all test results, including
    passing tests.
    """
    gradle_file = "gradle/testing/defaults-tests.gradle"

    new_content = """testLogging {
  showStandardStreams = true
  // set options for log level LIFECYCLE
  events TestLogEvent.FAILED,
         TestLogEvent.PASSED,
         TestLogEvent.SKIPPED,
         TestLogEvent.STANDARD_OUT
  exceptionFormat TestExceptionFormat.FULL
  showExceptions true
  showCauses true
  showStackTraces true

  // set options for log level DEBUG and INFO
  debug {
      events TestLogEvent.STARTED,
             TestLogEvent.FAILED,
             TestLogEvent.PASSED,
             TestLogEvent.SKIPPED,
             TestLogEvent.STANDARD_ERROR,
             TestLogEvent.STANDARD_OUT
      exceptionFormat TestExceptionFormat.FULL
  }
  info.events = debug.events
  info.exceptionFormat = debug.exceptionFormat

  afterSuite { desc, result ->
      if (!desc.parent) { // will match the outermost suite
          def output = "Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)"
          def startItem = '|  ', endItem = '  |'
          def repeatLength = startItem.length() + output.length() + endItem.length()
          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))
      }
  }
}"""

    return [
        f"""
sed -i '
/testLogging {{/,/}}/{{
  /testLogging {{/r /dev/stdin
  d
}}
' {gradle_file} << 'EOF'
{new_content}
EOF
""".strip()
    ]


def make_rxjava_pre_install_script() -> List[str]:
    """
    This script modifies the gradle config to print all test results, including
    passing tests.
    """
    gradle_file = "build.gradle"

    new_content = """testLogging {
    outputs.upToDateWhen { false }
    showStandardStreams = true
    showStackTraces = true

    // Show output for all logging levels
    events = ['passed', 'skipped', 'failed', 'standardOut', 'standardError']

    // set options for log level LIFECYCLE
    events org.gradle.api.tasks.testing.logging.TestLogEvent.FAILED,
           org.gradle.api.tasks.testing.logging.TestLogEvent.PASSED,
           org.gradle.api.tasks.testing.logging.TestLogEvent.SKIPPED,
           org.gradle.api.tasks.testing.logging.TestLogEvent.STANDARD_OUT,
           org.gradle.api.tasks.testing.logging.TestLogEvent.STANDARD_ERROR
    exceptionFormat org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    showExceptions true
    showCauses true
    showStackTraces true

    // set options for log level DEBUG and INFO
    debug {
        events org.gradle.api.tasks.testing.logging.TestLogEvent.STARTED,
               org.gradle.api.tasks.testing.logging.TestLogEvent.FAILED,
               org.gradle.api.tasks.testing.logging.TestLogEvent.PASSED,
               org.gradle.api.tasks.testing.logging.TestLogEvent.SKIPPED,
               org.gradle.api.tasks.testing.logging.TestLogEvent.STANDARD_ERROR,
               org.gradle.api.tasks.testing.logging.TestLogEvent.STANDARD_OUT
        exceptionFormat org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
    info.events = debug.events
    info.exceptionFormat = debug.exceptionFormat

    afterSuite { desc, result ->
        if (!desc.parent) { // will match the outermost suite
            def output = "Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)"
            def startItem = '|  ', endItem = '  |'
            def repeatLength = startItem.length() + output.length() + endItem.length()
            println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))
        }
    }
}"""

    return [
        f"""
sed -i '
/testLogging {{/,/}}/{{
  /testLogging {{/r /dev/stdin
  d
}}
' {gradle_file} << 'EOF'
{new_content}
EOF
""".strip()
    ]


# Constants - Task Instance Installation Environment
SPECS_GSON = {
    "2158": {
        "docker_specs": {"java_version": "11"},
        "install": ["mvn clean install -B -pl gson -DskipTests -am"],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testByteSerialization",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testShortSerialization",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testIntSerialization",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testLongSerialization",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testFloatSerialization",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testDoubleSerialization",
            # PASS_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testPrimitiveIntegerAutoboxedSerialization",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testPrimitiveIntegerAutoboxedInASingleElementArraySerialization",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testReallyLongValuesSerialization",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testPrimitiveLongAutoboxedSerialization",
        ],
    },
    "2024": {
        "docker_specs": {"java_version": "11"},
        "install": ["mvn clean install -B -pl gson -DskipTests -am"],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.FieldNamingTest#testUpperCaseWithUnderscores",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.NamingPolicyTest#testGsonWithUpperCaseUnderscorePolicySerialization",
            "mvnd test -B -pl gson -Dtest=com.google.gson.functional.NamingPolicyTest#testGsonWithUpperCaseUnderscorePolicyDeserialiation",
        ],
    },
    "2479": {
        "docker_specs": {"java_version": "11"},
        "install": ["mvn clean install -B -pl gson -DskipTests -am"],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.GsonBuilderTest#testRegisterTypeAdapterForObjectAndJsonElements",
            "mvnd test -B -pl gson -Dtest=com.google.gson.GsonBuilderTest#testRegisterTypeHierarchyAdapterJsonElements",
            # PASS_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.GsonBuilderTest#testModificationAfterCreate",
        ],
    },
    "2134": {
        "docker_specs": {"java_version": "11"},
        "install": ["mvn clean install -B -pl gson -DskipTests -am"],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.internal.bind.util.ISO8601UtilsTest#testDateParseInvalidDay",
            "mvnd test -B -pl gson -Dtest=com.google.gson.internal.bind.util.ISO8601UtilsTest#testDateParseInvalidMonth",
            # PASS_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.internal.bind.util.ISO8601UtilsTest#testDateParseWithDefaultTimezone",
        ],
    },
    "2061": {
        "docker_specs": {"java_version": "11"},
        "install": ["mvn clean install -B -pl gson -DskipTests -am"],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.stream.JsonReaderTest#testHasNextEndOfDocument",
            "mvnd test -B -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testHasNext_endOfDocument",
            # PASS_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.stream.JsonReaderTest#testReadEmptyObject",
            "mvnd test -B -pl gson -Dtest=com.google.gson.stream.JsonReaderTest#testReadEmptyArray",
            "mvnd test -B -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testSkipValue_emptyJsonObject",
            "mvnd test -B -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testSkipValue_filledJsonObject",
        ],
    },
    "2311": {
        "docker_specs": {"java_version": "11"},
        "install": ["mvn clean install -B -pl gson -DskipTests -am"],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.JsonPrimitiveTest#testEqualsIntegerAndBigInteger",
            # PASS_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.JsonPrimitiveTest#testLongEqualsBigInteger",
            "mvnd test -B -pl gson -Dtest=com.google.gson.JsonPrimitiveTest#testEqualsAcrossTypes",
        ],
    },
    "1100": {
        "docker_specs": {"java_version": "11"},
        "install": ["mvn clean install -B -pl gson -DskipTests -am"],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.DefaultDateTypeAdapterTest#testNullValue",
            # PASS_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.DefaultDateTypeAdapterTest#testDatePattern",
            "mvnd test -B -pl gson -Dtest=com.google.gson.DefaultDateTypeAdapterTest#testInvalidDatePattern",
        ],
    },
    "1093": {
        "docker_specs": {"java_version": "11"},
        "install": ["mvn clean install -B -pl gson -DskipTests -am"],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testNonFiniteDoublesWhenLenient",
            # PASS_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testNonFiniteBoxedDoublesWhenLenient",
            "mvnd test -B -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testNonFiniteDoubles",
            "mvnd test -B -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testNonFiniteBoxedDoubles",
            "mvnd test -B -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testDoubles",
        ],
    },
    "1014": {
        "docker_specs": {"java_version": "11"},
        "install": ["mvn clean install -B -pl gson -DskipTests -am"],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testSkipValue_emptyJsonObject",
            "mvnd test -B -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testSkipValue_filledJsonObject",
        ],
    },
}

SPECS_DRUID = {
    "15402": {
        "docker_specs": {"java_version": "11"},
        "install": [
            "mvn clean install -B -pl processing -DskipTests -am",
        ],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl processing -Dtest=org.apache.druid.query.groupby.GroupByQueryQueryToolChestTest#testCacheStrategy",
            # PASS_TO_PASS
            "mvnd test -B -pl processing -Dtest=org.apache.druid.query.groupby.GroupByQueryQueryToolChestTest#testResultLevelCacheKeyWithSubTotalsSpec",
            "mvnd test -B -pl processing -Dtest=org.apache.druid.query.groupby.GroupByQueryQueryToolChestTest#testMultiColumnCacheStrategy",
        ],
    },
    "14092": {
        "docker_specs": {"java_version": "11"},
        "install": [
            "mvn clean install -B -pl processing,cloud/aws-common,cloud/gcp-common -DskipTests -am",
        ],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl server -Dtest=org.apache.druid.discovery.DruidLeaderClientTest#test503ResponseFromServerAndCacheRefresh",
            # PASS_TO_PASS
            "mvnd test -B -pl server -Dtest=org.apache.druid.discovery.DruidLeaderClientTest#testServerFailureAndRedirect",
        ],
    },
    "14136": {
        "docker_specs": {"java_version": "11"},
        "install": [
            "mvn clean install -B -pl processing -DskipTests -am",
        ],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirstZeroLengthInterval",
            "mvnd test -B -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirstZeroLengthInterval2",
            "mvnd test -B -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirstZeroLengthInterval3",
            "mvnd test -B -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirstZeroLengthInterval4",
            # PASS_TO_PASS
            "mvnd test -B -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapFirstContainsSecond",
            "mvnd test -B -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirst",
        ],
    },
    "13704": {
        "docker_specs": {"java_version": "11"},
        "install": [
            # Update the pom.xml to use the correct version of the resource bundle. See https://github.com/apache/druid/pull/14054
            r"sed -i 's/<resourceBundle>org.apache.apache.resources:apache-jar-resource-bundle:1.5-SNAPSHOT<\/resourceBundle>/<resourceBundle>org.apache.apache.resources:apache-jar-resource-bundle:1.5<\/resourceBundle>/' pom.xml",
            "mvn clean install -B -pl processing -DskipTests -am",
        ],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl processing -Dtest=org.apache.druid.query.aggregation.post.ArithmeticPostAggregatorTest#testPow",
            # PASS_TO_PASS
            "mvnd test -B -pl processing -Dtest=org.apache.druid.query.aggregation.post.ArithmeticPostAggregatorTest#testDiv",
            "mvnd test -B -pl processing -Dtest=org.apache.druid.query.aggregation.post.ArithmeticPostAggregatorTest#testQuotient",
        ],
    },
    "16875": {
        "docker_specs": {"java_version": "11"},
        "install": [
            "mvn clean install -B -pl server -DskipTests -am",
        ],
        "test_cmd": [
            # FAIL_TO_PASS
            "mvnd test -B -pl server -Dtest=org.apache.druid.server.metrics.WorkerTaskCountStatsMonitorTest#testMonitorWithPeon",
            # PASS_TO_PASS
            "mvnd test -B -pl server -Dtest=org.apache.druid.server.metrics.WorkerTaskCountStatsMonitorTest#testMonitorWithNulls",
            "mvnd test -B -pl server -Dtest=org.apache.druid.server.metrics.WorkerTaskCountStatsMonitorTest#testMonitorIndexer",
        ],
    },
}

SPECS_JAVAPARSER = {
    "4561": {
        "docker_specs": {"java_version": "17"},
        # build is run before patch is applied to recompile the relevant files
        "build": [
            "./mvnw clean install -B -pl javaparser-symbol-solver-testing -DskipTests -am"
        ],
        "test_cmd": [
            # FAIL_TO_PASS
            "./mvnw test -B -pl javaparser-symbol-solver-testing -Dtest=Issue4560Test",
            # PASS_TO_PASS
            "./mvnw test -B -pl javaparser-symbol-solver-testing -Dtest=JavaSymbolSolverTest",
        ],
    },
    "4538": {
        "docker_specs": {"java_version": "17"},
        "build": [
            "./mvnw clean install -B -pl javaparser-core-testing -DskipTests -am"
        ],
        "test_cmd": [
            # FAIL_TO_PASS
            "./mvnw test -B -pl javaparser-core-testing -Dtest=NodeTest",
            # PASS_TO_PASS
            "./mvnw test -B -pl javaparser-core-testing -Dtest=NodePositionTest",
        ],
    },
}

SPECS_LOMBOK = {
    # Note: With some instances, PASS_TO_PASS only contains a few tests
    # relevant to the instance, not all the tests that pass
    "3602": {
        "docker_specs": {"java_version": "11"},
        "pre_install": make_lombok_pre_install_script(
            ["lombok.bytecode.TestPostCompiler"]
        ),
        "build": ["ant test.compile"],
        "test_cmd": ["ant test.instance"],
    },
    **{
        k: {
            "docker_specs": {"java_version": "11"},
            "pre_install": make_lombok_pre_install_script(
                ["lombok.transform.TestWithDelombok"]
            ),
            "build": ["ant test.compile"],
            "test_cmd": ["ant test.instance"],
        }
        for k in [
            "3312",
            "3697",
            "3326",
            "3674",
            "3594",
            "3422",
            "3215",
            "3486",
            "3042",
            "3052",
            "2792",
        ]
    },
    **{
        k: {
            "docker_specs": {"java_version": "17"},
            "pre_install": make_lombok_pre_install_script(
                ["lombok.transform.TestWithDelombok"]
            ),
            "build": ["ant test.compile"],
            "test_cmd": ["ant test.instance"],
        }
        for k in ["3571", "3479", "3371", "3350", "3009"]
    },
}

SPECS_LUCENE = {
    "13494": {
        "docker_specs": {"java_version": "21"},
        "pre_install": make_lucene_pre_install_script(),
        # No install script, download dependencies and compile in the test phase
        "test_cmd": [
            "./gradlew test --tests org.apache.lucene.facet.TestStringValueFacetCounts",
        ],
    },
    "13704": {
        "docker_specs": {"java_version": "21"},
        "pre_install": make_lucene_pre_install_script(),
        "test_cmd": [
            "./gradlew test --tests org.apache.lucene.search.TestLatLonDocValuesQueries",
        ],
    },
    "13301": {
        "docker_specs": {"java_version": "21"},
        "pre_install": make_lucene_pre_install_script(),
        "test_cmd": [
            "./gradlew test --tests TestXYPoint.testEqualsAndHashCode -Dtests.seed=3ABEFE4D876DD310 -Dtests.nightly=true -Dtests.locale=es-419 -Dtests.timezone=Asia/Ulaanbaatar -Dtests.asserts=true -Dtests.file.encoding=UTF-8",
        ],
    },
    "12626": {
        "docker_specs": {"java_version": "21"},
        "pre_install": make_lucene_pre_install_script(),
        "test_cmd": ["./gradlew test --tests org.apache.lucene.index.TestIndexWriter"],
    },
    "12212": {
        "docker_specs": {"java_version": "17"},
        "pre_install": make_lucene_pre_install_script(),
        "test_cmd": [
            "./gradlew test --tests org.apache.lucene.facet.TestDrillSideways"
        ],
    },
    "13170": {
        "docker_specs": {"java_version": "21"},
        "pre_install": make_lucene_pre_install_script(),
        "test_cmd": [
            # -Ptests.useSecurityManager=false disables extra logging that can cause the test output
            # parser to incorrectly mark a passing test as failed
            "./gradlew test --tests org.apache.lucene.analysis.opennlp.TestOpenNLPSentenceBreakIterator -Ptests.useSecurityManager=false"
        ],
    },
    "12196": {
        "docker_specs": {"java_version": "17"},
        "pre_install": make_lucene_pre_install_script(),
        "test_cmd": [
            "./gradlew test --tests org.apache.lucene.queryparser.classic.TestMultiFieldQueryParser"
        ],
    },
    "12022": {
        "docker_specs": {"java_version": "17"},
        "pre_install": make_lucene_pre_install_script(),
        "test_cmd": [
            "./gradlew test --tests org.apache.lucene.document.TestLatLonShape"
        ],
    },
    "11760": {
        "docker_specs": {"java_version": "17"},
        "pre_install": make_lucene_pre_install_script(),
        "test_cmd": [
            "./gradlew test --tests org.apache.lucene.queries.intervals.TestIntervalBuilder"
        ],
    },
}

SPECS_RXJAVA = {
    "7597": {
        "docker_specs": {"java_version": "11"},
        "pre_install": make_rxjava_pre_install_script(),
        "test_cmd": [
            "./gradlew test --tests io.reactivex.rxjava3.internal.operators.observable.ObservableSwitchTest"
        ],
    },
}

MAP_REPO_VERSION_TO_SPECS_JAVA = {
    "google/gson": SPECS_GSON,
    "apache/druid": SPECS_DRUID,
    "javaparser/javaparser": SPECS_JAVAPARSER,
    "projectlombok/lombok": SPECS_LOMBOK,
    "apache/lucene": SPECS_LUCENE,
    "reactivex/rxjava": SPECS_RXJAVA,
}

# Constants - Repository Specific Installation Instructions
MAP_REPO_TO_INSTALL_JAVA = {}

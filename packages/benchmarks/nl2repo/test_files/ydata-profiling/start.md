## Introduction and Objectives of the ydata-profiling Project

ydata-profiling is an automated exploratory data analysis (EDA) tool library for data science and data analysis. Its core objective is to provide a one-click, structured, visual, and exportable comprehensive data analysis report for pandas DataFrames, significantly enhancing the efficiency of data understanding, data quality assessment, and automated pre-feature engineering analysis. ydata-profiling supports functions such as type inference, univariate and multivariate analysis, missing and anomaly detection, correlation analysis, time series and text analysis, data quality warnings, report export, and multi-dataset comparison. It is suitable for various scenarios in data science projects, including initial data understanding, data cleaning, feature engineering, and automatic generation of data reports. The project supports multiple backends such as pandas and pyspark, with good scalability and integration capabilities.

## Natural Language Instruction (Prompt)

Please create a Python project named ydata-profiling to implement an automated data exploration and analysis library. The project should include the following functions:

1. Automatic data type inference: Automatically identify the data types of each column in the DataFrame (numeric, categorical, boolean, time, text, file, image, path, URL, time series, etc.) and display the type distribution in the report.
2. Univariate statistical analysis: Generate descriptive statistics (such as mean, variance, quantiles, unique values, missing values, extreme values, distribution histograms, etc.) for each column and support various visualizations.
3. Multivariate correlation analysis: Automatically calculate various correlations (such as Pearson, Spearman, Phi_k, Cramér's V, Kendall, etc.) and generate correlation matrices and visualizations.
4. Missing value and anomaly detection: Count missing values, zero values, unique values, constants, extreme values, abnormal distributions, etc., and generate visualizations of missing values (bar charts, heatmaps, matrix plots, etc.).
5. Duplicate value detection: Detect and count duplicate rows and approximately duplicate rows and display them in the report.
6. Data quality warnings: Automatically generate data quality warnings (such as high correlation, high cardinality, constants, uniqueness, dirty categories, skewness, uniform distribution, non-stationarity, seasonality, etc.) and highlight them in the report.
7. Sample sampling and display: Support various sample sampling methods (head, tail, random, custom) and display sample data in the report.
8. Time series analysis: Automatically analyze features such as autocorrelation, seasonality, and trends for time series data and generate relevant visualizations.
9. Text and file/image analysis: Conduct specialized analysis on special types of data such as text, files, and images (such as character distribution, EXIF, hashing, etc.) and display them in the report.
10. Interaction relationships and visualizations: Automatically generate interaction relationships between variables (such as scatter plot matrices, interaction heatmaps, etc.) and support interactive visualizations.
11. Report export and multi-format support: Support multiple report export methods such as HTML, JSON, and Jupyter widgets for easy team sharing and automated integration.
12. Multi-dataset comparison: Support automatic comparison analysis of the structure and distribution of two datasets and output a difference report.
13. Flexible configuration: Support YAML/py configuration, command-line parameters, and multiple modes such as minimal/sensitive/exploratory for flexible use in different scenarios.
14. Multi-backend support: Support multiple data processing backends such as pandas and pyspark to adapt to big data and distributed scenarios.
15. Integration and extensibility: Support integration with various environments such as Jupyter Notebook, command line interface, and Python scripts, with good extensibility through custom handlers and summarizers.
16. Typical usage and examples: Provide detailed API usage, command-line usage, Jupyter usage, and typical dataset analysis examples.
17. Automated testing and quality assurance: Design automated test cases for all the above functional points, covering the main processes, abnormal boundaries, different data types, and backends to ensure the robustness of the functions.
18. Core file requirements:
The project must include a comprehensive `pyproject.toml` file that not only configures the project as an installable package (supporting pip install), but also declares a complete dependency list (including core libraries such as `scipy>=1.4.1`, `pandas>1.1`, `matplotlib>=3.5`, `pytest`, etc.). pyproject.toml can verify whether all functional modules are working properly, and at the same time, it needs to provide `src/ydata_profiling/__init__.py` as a unified API entry to import and export core functions, classes, etc. from the core module, and provide version information, so that users can access all main functions through a simple "from ydata_profiling import **" statement.


## Dependencies and Project Structure Suggestions

### Main Dependencies and Versions

**Core Dependencies:**

- pandas >1.1, < 3.0, !=1.4.0
- numpy >=1.16.0, <2.2
- matplotlib >=3.5, <=3.10
- scipy >=1.4.1, <1.16
- jinja2 >=2.11.1, < 3.2
- visions[type_image_path] >=0.7.5, <0.8.2
- phik >=0.11.1, <0.13
- pydantic >=2
- PyYAML >=5.0.0, <6.1
- tqdm >=4.48.2, <5
- seaborn >=0.10.1, <0.14
- statsmodels >=0.13.2, <1
- typeguard >=3, <5
- minify-html>=0.15.0
- requests >=2.24.0, < 3
- multimethod >=1.4, <2
- imagehash ==4.3.1
- wordcloud >=1.9.3
- dacite >=1.8
- numba >=0.56.0, <=0.61

**Optional Dependencies:**

- pyspark >=4.0 (for big data/distributed support)
- pyarrow >=4.0.0 (for Spark/Parquet support)
- jupyter, ipywidgets (for notebook widgets)
- tangled-up-in-unicode ==0.2.0 (for Unicode analysis)
- pytest, coverage, nbval, etc. (for testing)

### Recommended Project Tree Structure

```markdown
workspace/
├── .devcontainer
│   ├── Dockerfile
│   ├── devcontainer.json
├── .github
│   ├── ISSUE_TEMPLATE
│   │   ├── bug_report_form.yaml
│   │   ├── feature_request_form.yaml
│   ├── PULL_REQUEST_TEMPLATE
│   │   ├── pull_request_template.md
│   ├── semantic.yml
│   ├── workflows
│   │   ├── docs.yaml
│   │   ├── merge-dev.yml
│   │   ├── merge-master.yml
│   │   ├── pull-request.yml
│   │   ├── release.yml
│   │   ├── sonarqube.yaml
│   │   ├── tests.yml
│   │   └── triage.yml
├── .gitignore
├── .pre-commit-config.yaml
├── .releaserc.json
├── CONTRIBUTING.md
├── LICENSE
├── MANIFEST.in
├── Makefile
├── README.md
├── commitlint.config.cjs
├── docs
│   ├── .DS_Store
│   ├── README.md
│   ├── _static
│   │   ├── img
│   │   │   ├── cli.png
│   │   │   ├── figure-git-workflow.svg
│   │   │   ├── iframe.gif
│   │   │   ├── multivariate_profiling.png
│   │   │   ├── outliers.png
│   │   │   ├── profiling_pipelines.png
│   │   │   ├── time-series_profiling.gif
│   │   │   ├── ts_gap_analysis.png
│   │   │   ├── univariate_profiling.png
│   │   │   ├── warnings_section.png
│   │   │   ├── widgets.gif
│   │   │   └── ydata-profiling.gif
│   ├── advanced_settings
│   │   ├── analytics.md
│   │   ├── available_settings.md
│   │   ├── caching.md
│   │   ├── changing_settings.md
│   │   ├── collaborative_data_profiling.md
│   │   ├── tables
│   │   │   ├── config_correlations.csv
│   │   │   ├── config_general.csv
│   │   │   ├── config_html.csv
│   │   │   ├── config_interactions.csv
│   │   │   ├── config_missing.csv
│   │   │   ├── config_variables.csv
│   │   │   └── corr_matrices.csv
│   ├── features
│   │   ├── big_data.md
│   │   ├── collaborative_data_profiling.md
│   │   ├── comparing_datasets.md
│   │   ├── custom_reports.md
│   │   ├── metadata.md
│   │   ├── pii_identification_management.md
│   │   ├── profile_values.md
│   │   ├── sensitive_data.md
│   │   ├── tables
│   │   │   ├── config_html.csv
│   │   ├── time_series_datasets.md
│   ├── getting-started
│   │   ├── concepts.md
│   │   ├── data_quality_alerts.csv
│   │   ├── examples.md
│   │   ├── installation.md
│   │   ├── quickstart.md
│   ├── index.md
│   ├── integrations
│   │   ├── bytewax.md
│   │   ├── great_expectations.md
│   │   ├── ides.md
│   │   ├── interactive_applications.md
│   │   ├── other_dataframe_libraries.md
│   │   ├── pipelines.md
│   │   ├── pyspark.md
│   ├── reference
│   │   ├── changelog.md
│   │   ├── history.md
│   │   ├── resources.md
│   ├── stylesheets
│   │   ├── extra.css
│   ├── support-contribution
│   │   ├── common_issues.md
│   │   ├── contribution_guidelines.md
│   │   └── help_troubleshoot.md
├── examples
│   ├── bank_marketing_data
│   │   ├── banking_data.py
│   ├── census
│   │   ├── census.py
│   │   ├── census_column_definition.json
│   ├── chicago_employees
│   │   ├── chicago_employees.py
│   ├── colors
│   │   ├── colors.py
│   ├── features
│   │   ├── correlation_auto_example.py
│   │   ├── correlation_demo.py
│   │   ├── eda_dataset_compare.py
│   │   ├── images_cats_and_dogs.py
│   │   ├── images_exif.py
│   │   ├── mask_sensitive.py
│   │   ├── russian_vocabulary.py
│   │   ├── spark_example.py
│   │   ├── theme_flatly_demo.py
│   │   ├── theme_united_demo.py
│   │   ├── urls.py
│   ├── hcc
│   │   ├── eda-with-feature-comparison.ipynb
│   │   ├── eda-with-feature-comparison.py
│   ├── integrations
│   │   ├── databricks
│   │   │   ├── ydata-profiling in Databricks.dbc
│   │   │   ├── ydata-profiling in Databricks.ipynb
│   │   ├── great_expectations
│   │   │   ├── great_expectations_example.py
│   │   ├── ydata_fabric_pipelines
│   │   │   └── data_profiling.ipynb
│   ├── meteorites
│   │   ├── meteorites.ipynb
│   │   ├── meteorites.py
│   │   ├── meteorites_cloud.ipynb
│   ├── musical_instrument_reviews
│   │   ├── review.py
│   ├── nza
│   │   ├── nza.py
│   ├── rdw
│   │   ├── rdw.py
│   ├── stata_auto
│   │   ├── stata_auto.py
│   ├── titanic
│   │   ├── titanic.ipynb
│   │   ├── titanic.py
│   │   ├── titanic_cloud.ipynb
│   ├── type_schema.py
│   ├── usaairquality
│   │   ├── usaairquality.ipynb
│   │   ├── usaairquality.py
│   ├── vektis
│   │   └── vektis.py
├── install.bat
├── make.bat
├── mkdocs.yml
├── pyproject.toml
├── renovate.json
├── src
│   ├── pandas_profiling
│   │   ├── __init__.py
│   ├── ydata_profiling
│   │   ├── __init__.py
│   │   ├── compare_reports.py
│   │   ├── config.py
│   │   ├── config_default.yaml
│   │   ├── config_minimal.yaml
│   │   ├── controller
│   │   │   ├── __init__.py
│   │   │   ├── console.py
│   │   │   ├── pandas_decorator.py
│   │   ├── expectations_report.py
│   │   ├── model
│   │   │   ├── __init__.py
│   │   │   ├── alerts.py
│   │   │   ├── correlations.py
│   │   │   ├── dataframe.py
│   │   │   ├── describe.py
│   │   │   ├── description.py
│   │   │   ├── duplicates.py
│   │   │   ├── expectation_algorithms.py
│   │   │   ├── handler.py
│   │   │   ├── missing.py
│   │   │   ├── pairwise.py
│   │   │   ├── pandas
│   │   │   │   ├── __init__.py
│   │   │   │   ├── correlations_pandas.py
│   │   │   │   ├── dataframe_pandas.py
│   │   │   │   ├── describe_boolean_pandas.py
│   │   │   │   ├── describe_categorical_pandas.py
│   │   │   │   ├── describe_counts_pandas.py
│   │   │   │   ├── describe_date_pandas.py
│   │   │   │   ├── describe_file_pandas.py
│   │   │   │   ├── describe_generic_pandas.py
│   │   │   │   ├── describe_image_pandas.py
│   │   │   │   ├── describe_numeric_pandas.py
│   │   │   │   ├── describe_path_pandas.py
│   │   │   │   ├── describe_supported_pandas.py
│   │   │   │   ├── describe_text_pandas.py
│   │   │   │   ├── describe_timeseries_pandas.py
│   │   │   │   ├── describe_url_pandas.py
│   │   │   │   ├── discretize_pandas.py
│   │   │   │   ├── duplicates_pandas.py
│   │   │   │   ├── imbalance_pandas.py
│   │   │   │   ├── missing_pandas.py
│   │   │   │   ├── sample_pandas.py
│   │   │   │   ├── summary_pandas.py
│   │   │   │   ├── table_pandas.py
│   │   │   │   ├── timeseries_index_pandas.py
│   │   │   │   ├── utils_pandas.py
│   │   │   ├── sample.py
│   │   │   ├── spark
│   │   │   │   ├── __init__.py
│   │   │   │   ├── correlations_spark.py
│   │   │   │   ├── dataframe_spark.py
│   │   │   │   ├── describe_boolean_spark.py
│   │   │   │   ├── describe_categorical_spark.py
│   │   │   │   ├── describe_counts_spark.py
│   │   │   │   ├── describe_date_spark.py
│   │   │   │   ├── describe_generic_spark.py
│   │   │   │   ├── describe_numeric_spark.py
│   │   │   │   ├── describe_supported_spark.py
│   │   │   │   ├── describe_text_spark.py
│   │   │   │   ├── duplicates_spark.py
│   │   │   │   ├── missing_spark.py
│   │   │   │   ├── sample_spark.py
│   │   │   │   ├── summary_spark.py
│   │   │   │   ├── table_spark.py
│   │   │   │   ├── timeseries_index_spark.py
│   │   │   ├── summarizer.py
│   │   │   ├── summary.py
│   │   │   ├── summary_algorithms.py
│   │   │   ├── table.py
│   │   │   ├── timeseries_index.py
│   │   │   ├── typeset.py
│   │   │   ├── typeset_relations.py
│   │   ├── profile_report.py
│   │   ├── report
│   │   │   ├── __init__.py
│   │   │   ├── formatters.py
│   │   │   ├── presentation
│   │   │   │   ├── __init__.py
│   │   │   │   ├── core
│   │   │   │   │   ├── __init__.py
│   │   │   │   │   ├── alerts.py
│   │   │   │   │   ├── collapse.py
│   │   │   │   │   ├── container.py
│   │   │   │   │   ├── correlation_table.py
│   │   │   │   │   ├── dropdown.py
│   │   │   │   │   ├── duplicate.py
│   │   │   │   │   ├── frequency_table.py
│   │   │   │   │   ├── frequency_table_small.py
│   │   │   │   │   ├── html.py
│   │   │   │   │   ├── image.py
│   │   │   │   │   ├── item_renderer.py
│   │   │   │   │   ├── renderable.py
│   │   │   │   │   ├── root.py
│   │   │   │   │   ├── sample.py
│   │   │   │   │   ├── scores.py
│   │   │   │   │   ├── table.py
│   │   │   │   │   ├── toggle_button.py
│   │   │   │   │   ├── variable.py
│   │   │   │   │   ├── variable_info.py
│   │   │   │   ├── flavours
│   │   │   │   │   ├── __init__.py
│   │   │   │   │   ├── flavour_html.py
│   │   │   │   │   ├── flavour_widget.py
│   │   │   │   │   ├── flavours.py
│   │   │   │   │   ├── html
│   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   ├── alerts.py
│   │   │   │   │   │   ├── collapse.py
│   │   │   │   │   │   ├── container.py
│   │   │   │   │   │   ├── correlation_table.py
│   │   │   │   │   │   ├── dropdown.py
│   │   │   │   │   │   ├── duplicate.py
│   │   │   │   │   │   ├── frequency_table.py
│   │   │   │   │   │   ├── frequency_table_small.py
│   │   │   │   │   │   ├── html.py
│   │   │   │   │   │   ├── image.py
│   │   │   │   │   │   ├── root.py
│   │   │   │   │   │   ├── sample.py
│   │   │   │   │   │   ├── scores.py
│   │   │   │   │   │   ├── table.py
│   │   │   │   │   │   ├── templates
│   │   │   │   │   │   │   ├── alerts
│   │   │   │   │   │   │   │   ├── alert_constant.html
│   │   │   │   │   │   │   │   ├── alert_constant_length.html
│   │   │   │   │   │   │   │   ├── alert_dirty_category.html
│   │   │   │   │   │   │   │   ├── alert_duplicates.html
│   │   │   │   │   │   │   │   ├── alert_empty.html
│   │   │   │   │   │   │   │   ├── alert_high_cardinality.html
│   │   │   │   │   │   │   │   ├── alert_high_correlation.html
│   │   │   │   │   │   │   │   ├── alert_imbalance.html
│   │   │   │   │   │   │   │   ├── alert_infinite.html
│   │   │   │   │   │   │   │   ├── alert_missing.html
│   │   │   │   │   │   │   │   ├── alert_near_duplicates.html
│   │   │   │   │   │   │   │   ├── alert_non_stationary.html
│   │   │   │   │   │   │   │   ├── alert_seasonal.html
│   │   │   │   │   │   │   │   ├── alert_skewed.html
│   │   │   │   │   │   │   │   ├── alert_truncated.html
│   │   │   │   │   │   │   │   ├── alert_type_date.html
│   │   │   │   │   │   │   │   ├── alert_uniform.html
│   │   │   │   │   │   │   │   ├── alert_unique.html
│   │   │   │   │   │   │   │   ├── alert_unsupported.html
│   │   │   │   │   │   │   │   ├── alert_zeros.html
│   │   │   │   │   │   │   ├── alerts.html
│   │   │   │   │   │   │   ├── collapse.html
│   │   │   │   │   │   │   ├── correlation_table.html
│   │   │   │   │   │   │   ├── diagram.html
│   │   │   │   │   │   │   ├── dropdown.html
│   │   │   │   │   │   │   ├── duplicate.html
│   │   │   │   │   │   │   ├── frequency_table.html
│   │   │   │   │   │   │   ├── frequency_table_small.html
│   │   │   │   │   │   │   ├── report.html
│   │   │   │   │   │   │   ├── sample.html
│   │   │   │   │   │   │   ├── scores.html
│   │   │   │   │   │   │   ├── sequence
│   │   │   │   │   │   │   │   ├── batch_grid.html
│   │   │   │   │   │   │   │   ├── grid.html
│   │   │   │   │   │   │   │   ├── list.html
│   │   │   │   │   │   │   │   ├── named_list.html
│   │   │   │   │   │   │   │   ├── overview_tabs.html
│   │   │   │   │   │   │   │   ├── scores.html
│   │   │   │   │   │   │   │   ├── sections.html
│   │   │   │   │   │   │   │   ├── select.html
│   │   │   │   │   │   │   │   ├── tabs.html
│   │   │   │   │   │   │   ├── table.html
│   │   │   │   │   │   │   ├── toggle_button.html
│   │   │   │   │   │   │   ├── variable.html
│   │   │   │   │   │   │   ├── variable_info.html
│   │   │   │   │   │   │   ├── wrapper
│   │   │   │   │   │   │   │   ├── assets
│   │   │   │   │   │   │   │   │   ├── bootstrap.bundle.min.js
│   │   │   │   │   │   │   │   │   ├── bootstrap.min.css
│   │   │   │   │   │   │   │   │   ├── cosmo.bootstrap.min.css
│   │   │   │   │   │   │   │   │   ├── flatly.bootstrap.min.css
│   │   │   │   │   │   │   │   │   ├── script.js
│   │   │   │   │   │   │   │   │   ├── simplex.bootstrap.min.css
│   │   │   │   │   │   │   │   │   ├── style.css
│   │   │   │   │   │   │   │   │   ├── united.bootstrap.min.css
│   │   │   │   │   │   │   │   ├── footer.html
│   │   │   │   │   │   │   │   ├── javascript.html
│   │   │   │   │   │   │   │   ├── navigation.html
│   │   │   │   │   │   │   │   └── style.html
│   │   │   │   │   │   ├── templates.py
│   │   │   │   │   │   ├── toggle_button.py
│   │   │   │   │   │   ├── variable.py
│   │   │   │   │   │   ├── variable_info.py
│   │   │   │   │   ├── widget
│   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   ├── alerts.py
│   │   │   │   │   │   ├── collapse.py
│   │   │   │   │   │   ├── container.py
│   │   │   │   │   │   ├── correlation_table.py
│   │   │   │   │   │   ├── dropdown.py
│   │   │   │   │   │   ├── duplicate.py
│   │   │   │   │   │   ├── frequency_table.py
│   │   │   │   │   │   ├── frequency_table_small.py
│   │   │   │   │   │   ├── html.py
│   │   │   │   │   │   ├── image.py
│   │   │   │   │   │   ├── notebook.py
│   │   │   │   │   │   ├── root.py
│   │   │   │   │   │   ├── sample.py
│   │   │   │   │   │   ├── table.py
│   │   │   │   │   │   ├── toggle_button.py
│   │   │   │   │   │   ├── variable.py
│   │   │   │   │   │   └── variable_info.py
│   │   │   │   ├── frequency_table_utils.py
│   │   │   ├── structure
│   │   │   │   ├── __init__.py
│   │   │   │   ├── correlations.py
│   │   │   │   ├── overview.py
│   │   │   │   ├── report.py
│   │   │   │   └── variables
│   │   │   │       ├── __init__.py
│   │   │   │       ├── render_boolean.py
│   │   │   │       ├── render_categorical.py
│   │   │   │       ├── render_common.py
│   │   │   │       ├── render_complex.py
│   │   │   │       ├── render_count.py
│   │   │   │       ├── render_date.py
│   │   │   │       ├── render_file.py
│   │   │   │       ├── render_generic.py
│   │   │   │       ├── render_image.py
│   │   │   │       ├── render_path.py
│   │   │   │       ├── render_real.py
│   │   │   │       ├── render_text.py
│   │   │   │       ├── render_timeseries.py
│   │   │   │       └── render_url.py
│   │   ├── serialize_report.py
│   │   ├── utils
│   │   │   ├── __init__.py
│   │   │   ├── backend.py
│   │   │   ├── cache.py
│   │   │   ├── common.py
│   │   │   ├── compat.py
│   │   │   ├── dataframe.py
│   │   │   ├── imghdr_patch.py
│   │   │   ├── information.py
│   │   │   ├── logger.py
│   │   │   ├── notebook.py
│   │   │   ├── paths.py
│   │   │   ├── progress_bar.py
│   │   │   ├── styles.py
│   │   │   ├── versions.py
│   │   └── visualisation
│   │       ├── __init__.py
│   │       ├── context.py
│   │       ├── missing.py
│   │       ├── plot.py
│   │       └── utils.py
└── venv
    └── spark.yml
```

## API Interface Documentation

### Core API

#### 1. ProfileReport Class

**Import Method**: `from ydata_profiling.profile_report import ProfileReport`

**Decorator**: `@typechecked`

**Inheritance**: `ProfileReport(SerializeReport, ExpectationsReport)`

**Class Signature**:

```python
@typechecked
class ProfileReport(SerializeReport, ExpectationsReport): 
 """Generate a profile report from a Dataset stored as a pandas `DataFrame`.

    Used as is, it will output its content as an HTML report in a Jupyter notebook.
    """
```

**Docstring**:
```
Generate a profile report from a Dataset stored as a pandas `DataFrame`.

Used as is, it will output its content as an HTML report in a Jupyter notebook.
```

**Class Attributes**:

```python
_description_set = None
_report = None
_html = None
_widgets = None
_json = None
config: Settings
```

**Constructor Signature**:

```python
def __init__(
    self,
    df: Optional[Union[pd.DataFrame, sDataFrame]] = None,
    minimal: bool = False,
    tsmode: bool = False,
    sortby: Optional[str] = None,
    sensitive: bool = False,
    explorative: bool = False,
    sample: Optional[dict] = None,
    config_file: Optional[Union[Path, str]] = None,
    lazy: bool = True,
    typeset: Optional[VisionsTypeset] = None,
    summarizer: Optional[BaseSummarizer] = None,
    config: Optional[Settings] = None,
    type_schema: Optional[dict] = None,
    **kwargs,
)
```

**Constructor Parameters**:

- `df`: a pandas or spark.sql DataFrame
- `minimal`: minimal mode is a default configuration with minimal computation
- `tsmode`: activates time-series analysis for all the numerical variables from the dataset. Only available for pd.DataFrame
- `sortby`: ignored if tsmode=False. Order the dataset by a provided column.
- `sensitive`: hides the values for categorical and text variables for report privacy
- `explorative`: exploratory mode (more analysis)
- `config_file`: a config file (.yml), mutually exclusive with `minimal`
- `lazy`: compute when needed
- `sample`: optional dict(name="Sample title", caption="Caption", data=pd.DataFrame())
- `typeset`: optional user typeset to use for type inference
- `summarizer`: optional user summarizer to generate custom summary output
- `config`: Settings configuration object
- `type_schema`: optional dict containing pairs of `column name`: `type`
- `**kwargs`: other arguments, for valid arguments, check the default configuration file.

**Methods**:

```python
@staticmethod
def __validate_inputs(
    df: Optional[Union[pd.DataFrame, sDataFrame]],
    minimal: bool,
    tsmode: bool,
    config_file: Optional[Union[Path, str]],
    lazy: bool,
) -> None: ...

@staticmethod
def __initialize_dataframe(
    df: Optional[Union[pd.DataFrame, sDataFrame]], report_config: Settings
) -> Optional[Union[pd.DataFrame, sDataFrame]]: ...

def invalidate_cache(self, subset: Optional[str] = None) -> None:
    """Invalidate report cache. Useful after changing setting.

    Args:
        subset:
        - "rendering" to invalidate the html, json and widget report rendering
        - "report" to remove the caching of the report structure
        - None (default) to invalidate all caches

    Returns:
        None
    """

def get_duplicates(self) -> Optional[pd.DataFrame]:
    """Get duplicate rows and counts based on the configuration

    Returns:
        A DataFrame with the duplicate rows and their counts.
    """

def get_sample(self) -> dict:
    """Get head/tail samples based on the configuration

    Returns:
        A dict with the head and tail samples.
    """

def get_description(self) -> BaseDescription:
    """Return the description (a raw statistical summary) of the dataset.

    Returns:
        Dict containing a description for each variable in the DataFrame.
    """

def get_rejected_variables(self) -> set:
    """Get variables that are rejected for analysis (e.g. constant, mixed data types)

    Returns:
        a set of column names that are unsupported
    """

def to_file(self, output_file: Union[str, Path], silent: bool = True) -> None:
    """Write the report to a file.

    Args:
        output_file: The name or the path of the file to generate including the extension (.html, .json).
        silent: if False, opens the file in the default browser or download it in a Google Colab environment
    """

def to_html(self) -> str:
    """Generate and return complete template as lengthy string
        for using with frameworks.

    Returns:
        Profiling report html including wrapper.
    """

def to_json(self) -> str:
    """Represent the ProfileReport as a JSON string

    Returns:
        JSON string
    """

def to_notebook_iframe(self) -> None:
    """Used to output the HTML representation to a Jupyter notebook.
    When config.notebook.iframe.attribute is "src", this function creates a temporary HTML file
    in `./tmp/profile_[hash].html` and returns an Iframe pointing to that contents.
    When config.notebook.iframe.attribute is "srcdoc", the same HTML is injected in the "srcdoc" attribute of
    the Iframe.

    Notes:
        This constructions solves problems with conflicting stylesheets and navigation links.
    """

def to_widgets(self) -> None:
    """The ipython notebook widgets user interface."""

def compare(self, other: "ProfileReport", config: Optional[Settings] = None) -> "ProfileReport":
    """Compare this report with another ProfileReport
    Alias for:
    ```
    ydata_profiling.compare([report1, report2], config=config)
    ```
    See `ydata_profiling.compare` for details.

    Args:
        other: the ProfileReport to compare to
        config: the settings object for the merged ProfileReport. If `None`, uses the caller's config

    Returns:
        Comparison ProfileReport
    """

def __repr__(self) -> str:
    """Override so that Jupyter Notebook does not print the object."""

def _repr_html_(self) -> None:
    """The ipython notebook widgets user interface gets called by the jupyter notebook."""
```

**Properties**:

```python

@property
def typeset(self) -> Optional[VisionsTypeset]:
    """Returns the typeset used for type inference"""

@property
def summarizer(self) -> BaseSummarizer:
    """Returns the summarizer used for statistical calculations"""

@property
def description_set(self) -> BaseDescription:
    """Returns the complete statistical description of the dataset"""

@property
def df_hash(self) -> Optional[str]:
    """Returns the hash of the DataFrame"""

@property
def report(self) -> Root:
    """Returns the report structure"""

@property
def html(self) -> str:
    """Returns the HTML representation of the report"""

@property
def json(self) -> str:
    """Returns the JSON representation of the report"""

@property
def widgets(self) -> Any:
    """Returns the widgets representation of the report"""
```

**Private/Internal Methods** (for reference):

- `_render_html() -> str`: Renders the report as HTML
- `_render_widgets() -> Any`: Renders the report as widgets
- `_render_json() -> str`: Renders the report as JSON

#### 2. compare Function
Function: Compares two ProfileReport objects or their descriptions and returns a merged report.

**Signature**:

```python
from ydata_profiling.profile_report import compare

def compare(
    reports: Union[List[ProfileReport], List[BaseDescription]],
    config: Optional[Settings] = None,
    compute: bool = False,
) -> ProfileReport:
    """
    Compare Profile reports

    Args:
        reports: two reports to compare
                 input may either be a ProfileReport, or the summary obtained from report.get_description()
        config: the settings object for the merged ProfileReport
        compute: recompute the profile report using config or the left report config
                 recommended in cases where the reports were created using different settings

    """
```

#### 3. profile_report Function

**Function**: This file adds the decorator on the DataFrame object. Adds a `profile_report` method to pandas.DataFrame for easy chaining.

**Signature**:

```python
from ydata_profiling.pandas_decorator import profile_report
def profile_report(df: DataFrame, **kwargs) -> ProfileReport:
    """Profile a DataFrame.

    Args:
        df: The DataFrame to profile.
        **kwargs: Optional arguments for the ProfileReport object.

    Returns:
        A ProfileReport of the DataFrame.
    """
```


**Note**: This decorator is automatically applied when ydata_profiling is imported, adding the `profile_report` method to all pandas DataFrame instances.

#### 4. __version__

**Function**: The current version number of ydata-profiling.

#### 5. display_banner
**Function**: Displays the project banner and prompt information in Jupyter or the terminal.

**Signature**:

```python
from ydata_profiling.utils.information import display_banner 

def display_banner() -> None: ...
```

**Function**: Displays the project banner and prompt information in Jupyter or the terminal.

### Configuration Class Details

#### Settings Configuration Class


**Class Signature**:

```python
from ydata_profiling.config import Settings

from pydantic.v1 import BaseModel, BaseSettings, Field, PrivateAttr

class Settings(BaseSettings): ...
```

**Function**: Manages global and categorical configurations, supporting flexible customization through multiple methods such as YAML files, objects, command lines, and APIs.

**Inner class Config** (Pydantic Configuration):

**Important**: This is the **Pydantic inner configuration class** for Settings, not to be confused with the `Config` utility class (see below).

```python
class Settings(BaseSettings):
    # ... fields ...

    class Config:
        """Pydantic model configuration"""
        env_prefix = "profile_"  # Default prefix for environment variables to avoid collisions
```

This inner Config class configures how Pydantic handles the Settings model, specifically setting the environment variable prefix for automatic loading from environment variables.

**Inheritance**:

Settings inherits from `pydantic.v1.BaseSettings`, which provides powerful data validation and settings management capabilities.

**Important Note on Pydantic Version**:
- ydata-profiling uses **Pydantic v1 compatibility mode** (`pydantic.v1`) to ensure compatibility with both Pydantic v1 and v2
- Import statement in source code: `from pydantic.v1 import BaseModel, BaseSettings, Field, PrivateAttr`
- This allows the package to work with Pydantic v2 while maintaining v1 API compatibility

**Inherited Pydantic Methods**:

Because Settings extends `pydantic.v1.BaseSettings`, it supports all standard Pydantic v1 methods:

- `dict()` - Convert Settings to dictionary representation
- `json()` - Convert Settings to JSON string
- `parse_obj(obj)` - Parse Settings from a Python object
- `parse_raw(b)` - Parse Settings from raw bytes/string
- `copy()` - Create a deep copy of Settings object
- `schema()` - Get JSON schema for Settings
- `schema_json()` - Get JSON schema as string
- `update_forward_refs()` - Update forward references in model
- `construct()` - Create Settings without validation (advanced use)
- `__fields__` - Access field definitions
- `__config__` - Access model configuration

For complete Pydantic functionality, see [Pydantic Documentation](https://docs.pydantic.dev/)

**Custom Methods**:

```python
def update(self, updates: dict) -> "Settings":
    """Update settings with new values using recursive dictionary merging

    This method creates a new Settings object with values from both the current
    settings and the updates dictionary. The updates take precedence over existing
    values, but the merge is deep/recursive for nested dictionaries.

    Args:
        updates: Dictionary of configuration updates to apply

    Returns:
        Settings: New Settings object with merged configuration

    Implementation:
        Uses _merge_dictionaries() to recursively merge self.dict() with updates,
        then creates a new Settings object from the merged dictionary.
    """
    ...

@staticmethod
def from_file(config_file: Union[Path, str]) -> "Settings":
    """Create a Settings object from a yaml file

    Args:
        config_file: yaml file path

    Returns:
        Settings: Settings object loaded from the YAML file
    """
    ...
```



**Main Fields (Complete with Types and Defaults)**:

```python
# Title of the document
title: str = "YData Profiling Report"

dataset: Dataset = Dataset()
variables: Variables = Variables()
infer_dtypes: bool = True

# Show the description at each variable (in addition to the overview tab)
show_variable_description: bool = True

# Number of workers (0=multiprocessing.cpu_count())
pool_size: int = 0

# Show the progress bar
progress_bar: bool = True

# Per variable type description settings
vars: Univariate = Univariate()

# Sort the variables. Possible values: ascending, descending or None (leaves original sorting)
sort: Optional[str] = None

missing_diagrams: Dict[str, bool] = {
    "bar": True,
    "matrix": True,
    "heatmap": True,
}

correlation_table: bool = True

correlations: Dict[str, Correlation] = {
    "auto": Correlation(key="auto", calculate=True),
    "spearman": Correlation(key="spearman", calculate=False),
    "pearson": Correlation(key="pearson", calculate=False),
    "phi_k": Correlation(key="phi_k", calculate=False),
    "cramers": Correlation(key="cramers", calculate=False),
    "kendall": Correlation(key="kendall", calculate=False),
}

interactions: Interactions = Interactions()

categorical_maximum_correlation_distinct: int = 100
# Use `deep` flag for memory_usage
memory_deep: bool = False
plot: Plot = Plot()
duplicates: Duplicates = Duplicates()
samples: Samples = Samples()

reject_variables: bool = True

# The number of observations to show
n_obs_unique: int = 10
n_freq_table_max: int = 10
n_extreme_obs: int = 10

# Report rendering
report: Report = Report()
html: Html = Html()
notebook: Notebook = Notebook()
```

**Important Configuration Container Classes**:

**Class Dataset**

**Function**: Stores metadata about the dataset being profiled.

**Fields**:

```python
from ydata_profiling.config import Dataset
class Dataset(BaseModel):
    description: str = ""
    creator: str = ""
    author: str = ""
    copyright_holder: str = ""
    copyright_year: str = ""
    url: str = ""
```

**Class Univariate**

**Function**: Container class that holds all variable-type-specific configuration objects.

**Fields**:

```python
from ydata_profiling.config import Univariate

class Univariate(BaseModel):
    num: NumVars = NumVars()           # Numeric variable settings
    text: TextVars = TextVars()        # Text variable settings
    cat: CatVars = CatVars()           # Categorical variable settings
    image: ImageVars = ImageVars()     # Image variable settings
    bool: BoolVars = BoolVars()        # Boolean variable settings
    path: PathVars = PathVars()        # Path variable settings
    file: FileVars = FileVars()        # File variable settings
    url: UrlVars = UrlVars()           # URL variable settings
    timeseries: TimeseriesVars = TimeseriesVars()  # Timeseries variable settings
```

#### Variable Type Configuration Classes

**Class NumVars**

**Function**: Configuration settings for numeric variable analysis.

**Fields**:

```python
from ydata_profiling.config import NumVars
class NumVars(BaseModel):
    quantiles: List[float] = [0.05, 0.25, 0.5, 0.75, 0.95]
    skewness_threshold: int = 20
    low_categorical_threshold: int = 5
    chi_squared_threshold: float = 0.999  # Set to zero to disable
```

**Class TextVars**


**Function**: Configuration settings for text variable analysis.

**Fields**:

```python
from ydata_profiling.config import TextVars
class TextVars(BaseModel):
    length: bool = True
    words: bool = True
    characters: bool = True
    redact: bool = False
```

**Class CatVars**

**Import Method**: `from ydata_profiling.config import CatVars`

**Inheritance**: `CatVars(BaseModel)`

**Function**: Configuration settings for categorical variable analysis.

**Fields**:

```python
from ydata_profiling.config import CatVars
class CatVars(BaseModel):
    length: bool = True
    characters: bool = True
    words: bool = True
    cardinality_threshold: int = 50  # if var has more than threshold categories, it's a text var
    percentage_cat_threshold: float = 0.5  # if var has more than threshold % distinct values, it's a text var
    imbalance_threshold: float = 0.5
    n_obs: int = 5
    chi_squared_threshold: float = 0.999  # Set to zero to disable
    coerce_str_to_date: bool = False
    redact: bool = False
    histogram_largest: int = 50
    stop_words: List[str] = []
    dirty_categories: bool = False
    dirty_categories_threshold: float = 0.85
```

**Class BoolVars**

**Function**: Configuration settings for boolean variable analysis.

**Fields**:

```python
from ydata_profiling.config import BoolVars

class BoolVars(BaseModel):
    n_obs: int = 3
    imbalance_threshold: float = 0.5
    # string to boolean mapping dict
    mappings: Dict[str, bool] = {
        "t": True, "f": False,
        "yes": True, "no": False,
        "y": True, "n": False,
        "true": True, "false": False,
    }
```

**Class FileVars**

**Function**: Configuration settings for file-type variable analysis.

**Fields**:

```python
from ydata_profiling.config import FileVars

class FileVars(BaseModel):
    active: bool = False
```

**Class PathVars**

**Function**: Configuration settings for path-type variable analysis.

**Fields**:

```python
from ydata_profiling.config import PathVars

class PathVars(BaseModel):
    active: bool = False
```

**Class ImageVars**

**Import Method**: `from ydata_profiling.config import ImageVars`

**Inheritance**: `ImageVars(BaseModel)`

**Function**: Configuration settings for image variable analysis.

**Fields**:

```python
from ydata_profiling.config import ImageVars

class ImageVars(BaseModel):
    active: bool = False
    exif: bool = True
    hash: bool = True
```

**Class UrlVars**

**Function**: Configuration settings for URL variable analysis.

**Fields**:

```python
from ydata_profiling.config import UrlVars

class UrlVars(BaseModel):
    active: bool = False
```

**Class TimeseriesVars**

**Function**: Configuration settings for timeseries variable analysis.

**Fields**:

```python
from ydata_profiling.config import TimeseriesVars

class TimeseriesVars(BaseModel):
    active: bool = False
    sortby: Optional[str] = None
    autocorrelation: float = 0.7
    lags: List[int] = [1, 7, 12, 24, 30]
    significance: float = 0.05
    pacf_acf_lag: int = 100
    autolag: Optional[str] = "AIC"
    maxlag: Optional[int] = None
```

#### Plot Configuration Classes

**Class MissingPlot**


**Function**: Configuration settings for missing value plot display.

**Fields**:

```python
from ydata_profiling.config import MissingPlot

class MissingPlot(BaseModel):
    quantiles: List[float] = [0.05, 0.25, 0.5, 0.75, 0.95]
    skewness_threshold: int = 20
    low_categorical_threshold: int = 5
    # Set to zero to disable
    chi_squared_threshold: float = 0.999

```

**Class ImageType**

**Function**: Enumeration for image format types.

**Members**:

```python
class ImageType(Enum):
    svg = "svg"
    png = "png"

```
**Class CorrelationPlot**

**Function**: Configuration settings for correlation plot styling.

**Fields**:

```python
from ydata_profiling.config import CorrelationPlot
class CorrelationPlot(BaseModel):
    cmap: str = "RdBu"
    bad: str = "#000000"

```

**Class Histogram**


**Function**: Configuration settings for histogram display.

**Fields**:

```python
from ydata_profiling.config import Histogram

class Histogram(BaseModel):
    # Number of bins (set to 0 to automatically detect the bin size)
    bins: int = 50
    # Maximum number of bins (when bins=0)
    max_bins: int = 250
    x_axis_labels: bool = True
    density: bool = False


```

**Class CatFrequencyPlot**

**Function**: Configuration settings for categorical frequency plots.

**Fields**:

```python
from ydata_profiling.config import CatFrequencyPlot

class CatFrequencyPlot(BaseModel):
    show: bool = True  # if false, the category frequency plot is turned off
    type: str = "bar"  # options: 'bar', 'pie'

    # The cat frequency plot is only rendered if the number of distinct values is
    # smaller or equal to "max_unique"
    max_unique: int = 10

    # Colors should be a list of matplotlib recognised strings:
    # --> https://matplotlib.org/stable/tutorials/colors/colors.html
    # --> matplotlib defaults are used by default
    colors: Optional[List[str]] = None
```

**Class Plot**

**Signature**:
```python
from ydata_profiling.config import Plot

class Plot(BaseModel):
    missing: MissingPlot = MissingPlot()
    image_format: ImageType = ImageType.svg
    correlation: CorrelationPlot = CorrelationPlot()
    dpi: int = 800  # PNG dpi
    histogram: Histogram = Histogram()
    scatter_threshold: int = 1000
    cat_freq: CatFrequencyPlot = CatFrequencyPlot()
    font_path: Optional[Union[Path, str]] = None
```

**Function**: Container class for all plot-related configuration settings. Aggregates settings for missing value plots, correlation plots, histograms, scatter plots, and categorical frequency plots.

**Fields**:

- `missing: MissingPlot` - Missing value plot configuration (default: MissingPlot())
- `image_format: ImageType` - Output image format, svg or png (default: ImageType.svg)
- `correlation: CorrelationPlot` - Correlation plot styling configuration (default: CorrelationPlot())
- `dpi: int` - DPI setting for PNG output (default: 800)
- `histogram: Histogram` - Histogram display configuration (default: Histogram())
- `scatter_threshold: int` - Threshold for switching to hexbin plots in scatter plots (default: 1000)
- `cat_freq: CatFrequencyPlot` - Categorical frequency plot configuration (default: CatFrequencyPlot())
- `font_path: Optional[Union[Path, str]]` - Custom font path for plots (default: None)

**Class Theme**

**Function**: Enumeration for HTML report themes.

**Members**:

```python
from ydata_profiling.config import Theme

class Theme(Enum):
    united = "united"
    flatly = "flatly"
    cosmo = "cosmo"
    simplex = "simplex"

```

**Class Style**

**Import Method**: `from ydata_profiling.config import Style`

**Inheritance**: `Style(BaseModel)`

**Function**: Configuration settings for report styling.

**Fields**:

```python
from ydata_profiling.config import Style

class Style(BaseModel):
primary_colors: List[str] = ["#0d6efd", "#dc3545", "#198754"]  # Primary color used for comparisons (default: blue, red, green)
logo: str = ""  # Base64-encoded logo image
theme: Optional[Theme] = None  # HTML Theme (optional, default: None)
_labels: List[str] = PrivateAttr(["_"])  # Labels used for comparing reports (private attribute)
```

**Properties**: 

```python
@property
def primary_color(self) -> str: ...

```

**Class Html**

**Function**: Configuration settings for HTML report output.

**Fields**:

```python
class Html(BaseModel):
    style: Style = Style()  # Styling options for the HTML report
    navbar_show: bool = True  # Show navbar
    minify_html: bool = True  # Minify the html
    use_local_assets: bool = True  # Offline support
    inline: bool = True  # If True, single file, else directory with assets
    assets_prefix: Optional[str] = None  # Assets prefix if inline = True
    assets_path: Optional[str] = None  # Internal usage
    full_width: bool = False
```

#### Analysis Configuration Classes

**Class Duplicates**

**Function**: Configuration settings for duplicate value detection.

**Fields**:

```python
from ydata_profiling.config import Duplicates

class Duplicates(BaseModel):
    head: int = 10
    key: str = "# duplicates"
```

**Class Correlation**

**Function**: Configuration settings for a single correlation method.

**Fields**:

```python
class Correlation(BaseModel):
    key: str = ""
    calculate: bool = Field(default=True)
    warn_high_correlations: int = Field(default=10)
    threshold: float = Field(default=0.5)
    n_bins: int = Field(default=10)
```

**Class Correlations**

**Function**: Configuration settings for all correlation analysis methods.

**Fields**:

```python
from ydata_profiling.config import Correlations

class Correlations(BaseModel):
    pearson: Correlation = Correlation(key="pearson")
    spearman: Correlation = Correlation(key="spearman")
    auto: Correlation = Correlation(key="auto")
```

**Class Interactions**

**Function**: Configuration settings for variable interaction analysis.

**Fields**:

```python
from ydata_profiling.config import Interactions 

class Interactions(BaseModel):
    continuous: bool = True  # Set to False to disable scatter plots
    targets: List[str] = []
```

**Class Samples**

**Function**: Configuration settings for sample data display.

**Fields**:

```python
from ydata_profiling.config import Samples

class Samples(BaseModel):
    head: int = 10
    tail: int = 10
    random: int = 0

```

**Class Variables**

**Function**: Configuration settings for variable descriptions.

**Fields**:

```python
from ydata_profiling.config import Variables

class Variables(BaseModel):
    descriptions: dict = {}
```

#### Notebook Configuration Classes

**Class IframeAttribute**

**Function**: Enumeration for iframe attribute types.

**Members**:

```python
from ydata_profiling.config import IframeAttribute

class IframeAttribute(Enum):
    src = "src"
    srcdoc = "srcdoc"
```

**Class Iframe**

**Function**: Configuration settings for Jupyter iframe display.

**Fields**:

```python
from ydata_profiling.config import IframeAttribute

class Iframe(BaseModel):
    height: str = "800px"
    width: str = "100%"
    attribute: IframeAttribute = IframeAttribute.srcdoc

```

**Class Notebook**

**Signature**:
```python
from ydata_profiling.config import Notebook

class Notebook(BaseModel):
    """When in a Jupyter notebook"""
```

**Function**: Configuration settings specific to Jupyter notebook environment for controlling how reports are displayed in notebooks.

**Fields**:

- `iframe: Iframe` - Iframe display configuration for notebook output (default: Iframe())

#### Report Configuration Class

**Class Report**

**Signature**:
```python
from ydata_profiling.config import Report
class Report(BaseModel):
    # Numeric precision for displaying statistics
```

**Function**: Configuration settings for report generation and formatting.

**Fields**:

- `precision: int` - Numeric precision for displaying statistics in the report (default: 8)

#### Spark Configuration Class

**Class SparkSettings**
**Function**: Specialized Settings class for Spark DataFrames with optimized defaults for distributed data processing.

**Key Overrides**:

```python
class SparkSettings(Settings):
    """
    Setting class with the standard report configuration for Spark DataFrames
    All the supported analysis are set to true
    """
    SparkSettings
    # Note: The following uses Pydantic's field override syntax for nested configuration.
    # This creates a new Univariate instance and modifies its nested field default values.
    vars: Univariate = Univariate()
    vars.num.low_categorical_threshold = 0  # Spark uses 0 instead of pandas default (disabled for Spark backend)
    infer_dtypes: bool = False
    correlations: Dict[str, Correlation] = {
        "spearman": Correlation(key="spearman", calculate=True),
        "pearson": Correlation(key="pearson", calculate=True),
    }
    correlation_table: bool = True
    interactions: Interactions = Interactions()
    interactions.continuous = False
    missing_diagrams: Dict[str, bool] = {
        "bar": False,
        "matrix": False,
        "dendrogram": False,
        "heatmap": False,
    }
    samples: Samples = Samples()
    samples.tail = 0
    samples.random = 0
```

#### Helper Functions

**Function _merge_dictionaries**

**Function**: Recursively merges two dictionaries, with the second dictionary taking precedence.

**Signature**:
```python
from ydata_profiling.config import _merge_dictionaries

def _merge_dictionaries(dict1: dict, dict2: dict) -> dict:
    """Recursive merge dictionaries

    Args:
        dict1: Base dictionary to merge
        dict2: Dictionary to merge on top of base dictionary

    Returns:
        dict: Merged dictionary
    """
    ...
```

**Parameters**:
- `dict1: dict` - Base dictionary to merge (values used if key not in dict2)
- `dict2: dict` - Dictionary to merge on top of base dictionary (takes precedence)

**Returns**: `dict` - Merged dictionary (dict2 is modified in-place and returned)

**Algorithm**:
1. Iterate through all keys in dict1
2. If a value is a dictionary:
   - Recursively merge with the corresponding nested dict in dict2
   - Creates empty dict in dict2 if key doesn't exist
3. If a value is not a dictionary:
   - Only copy to dict2 if the key doesn't already exist in dict2
4. Returns dict2 (modified)

**Important Note**: This function modifies dict2 in-place. dict2 values take precedence over dict1 values.

**Internal Usage**: This function is used by `Settings.update()` to merge configuration updates with existing settings.

---

#### Config Utility Class

**Class Config**

**Important**: This is the **Config utility class**, not to be confused with `Settings.Config` (Pydantic inner class above).

**Signature**:
```python
from ydata_profiling.config import Config

class Config:
    """Utility class for predefined configuration groups and shorthands"""

    arg_groups: Dict[str, Any] = {...}
    _shorthands: Dict[str, Any] = {...}

    @staticmethod
    def get_arg_groups(key: str) -> dict: ...

    @staticmethod
    def shorthands(kwargs: dict, split: bool = True) -> Tuple[dict, dict]: ...
```

**Function**: Provides utility methods for managing predefined configuration groups and shorthand notation for common settings patterns.

**Class Attributes**:

**arg_groups**: Predefined configuration groups for common use cases

```python
arg_groups = {
    "sensitive": {
        "samples": None,
        "duplicates": None,
        "vars": {"cat": {"redact": True}, "text": {"redact": True}},
    },
    "flatly_theme": {
        "html": {"style": {"theme": Theme.flatly, "primary_color": "#2c3e50"}}
    },
    "united_theme": {
        "html": {"style": {"theme": Theme.united, "primary_color": "#d34615"}}
    },
    "explorative": {
        "vars": {
            "cat": {"characters": True, "words": True},
            "url": {"active": True},
            "path": {"active": True},
            "file": {"active": True},
            "image": {"active": True},
        },
        "n_obs_unique": 10,
        "n_extreme_obs": 10,
        "n_freq_table_max": 10,
        "memory_deep": True,
    },
}
```

**_shorthands**: Shorthand expansions for common configuration patterns

```python
_shorthands = {
    "dataset": {
        "creator": "",
        "author": "",
        "description": "",
        "copyright_holder": "",
        "copyright_year": "",
        "url": "",
    },
    "samples": {"head": 0, "tail": 0, "random": 0},
    "duplicates": {"head": 0},
    "interactions": {"targets": [], "continuous": False},
    "missing_diagrams": {"bar": False, "matrix": False, "heatmap": False},
    "correlations": {
        "auto": {"calculate": False},
        "pearson": {"calculate": False},
        "spearman": {"calculate": False},
        "kendall": {"calculate": False},
        "phi_k": {"calculate": False},
        "cramers": {"calculate": False},
    },
    "correlation_table": True,
}
```

**Methods**:

```python
@staticmethod
def get_arg_groups(key: str) -> dict:
    """Get a predefined configuration group

    Args:
        key: Name of the configuration group (e.g., "sensitive", "explorative", "flatly_theme", "united_theme")

    Returns:
        dict: Configuration dictionary with shorthand values expanded
    """
    ...

@staticmethod
def shorthands(kwargs: dict, split: bool = True) -> Tuple[dict, dict]:
    """Process configuration dict and expand shorthand values

    Args:
        kwargs: Configuration dictionary potentially containing shorthand keys
        split: If True, remove expanded shorthands from kwargs and return separately

    Returns:
        Tuple[dict, dict]: (shorthand_args, remaining_kwargs)
            - shorthand_args: Expanded shorthand configurations
            - remaining_kwargs: Original kwargs with shorthands removed (if split=True) or empty dict (if split=False)
    """
    ...
```


#### Path Utility

**Function get_config**

**Function**: Gets the path of the configuration file.
```python

from ydata_profiling.utils.paths import get_config

def get_config(file_name: str) -> Path:
```


### Data Modeling and Analysis Module

#### Data Type System

**Class ProfilingTypeSet**

**Function**: It is a custom data type collection class that inherits from visions.VisionsTypeset

```python
from ydata_profiling.model.typeset import ProfilingTypeSet

class ProfilingTypeSet(visions.VisionsTypeset):
    def __init__(self, config: Settings, type_schema: dict = None): ...
    def _init_type_schema(self, type_schema: dict) -> dict: ...
    def _get_type(self, type_name: str) -> visions.VisionsBaseType: ...
    
```
**Parameters** (__init__):
- `config: Settings` - Configuration settings for the type set
- `type_schema: dict = None` - Custom type schema for overriding default types (optional, default: None)


**Function compose**

**Function**: Composes a sequence of functions into a single function that applies them sequentially.

**Signature**:
```python
from ydata_profiling.model.handler import compose

def compose(functions: Sequence[Callable]) -> Callable:
    def def composed_function(*args) -> List[Any]: ...
    """Compose a sequence of functions

    Args:
        functions: Sequence of functions to compose

    Returns:
        Callable: Combined function applying all functions in order
    """
    ...
```

**Parameters**:
- `functions: Sequence[Callable]` - Sequence of functions to be composed and applied sequentially

**Returns**: `Callable` - A composed function that applies all input functions in order, passing the output of each function as input to the next

**Implementation Details**:
The compose function creates a closure that:
1. Starts with the input arguments
2. Applies each function in the sequence
3. Handles both tuple results (unpacks with `*`) and single results
4. Returns the final result after all functions have been applied

---

**Class Handler**

**Signature**:
```python
from ydata_profiling.model.handler import Handler

class Handler:
    """A generic handler

    Allows any custom mapping between data types and functions
    """

```

**Class**: A generic handler that manages custom mappings between data types and processing functions. It allows flexible dispatching of operations based on type information using a directed acyclic graph (DAG) structure.

**Parameters**:
- `mapping: Dict[str, List[Callable]]` - Dictionary mapping type names (as strings) to lists of callable functions. Each type can have multiple functions that will be composed and applied in sequence.
- `typeset: VisionsTypeset` - A Visions typeset containing type hierarchy information. Used to complete the DAG by propagating functions along type inheritance chains.
- `*args` - Additional positional arguments
- `**kwargs` - Additional keyword arguments

**Methods**:

```python
def __init__(
    self,
    mapping: Dict[str, List[Callable]],
    typeset: VisionsTypeset,
    *args,
    **kwargs
):
    """Initialize Handler with type mapping and typeset

    Args:
        mapping: Dictionary mapping type names to lists of callable functions
        typeset: A Visions typeset containing type hierarchy information
        *args: Additional positional arguments
        **kwargs: Additional keyword arguments
    """
    ...

def handle(self, dtype: str, *args, **kwargs) -> dict:
    """Execute the composed function chain for a given data type

    Args:
        dtype: The data type name as a string
        *args: Additional positional arguments passed to the function chain
        **kwargs: Additional keyword arguments passed to the function chain

    Returns:
        dict: A summary dictionary containing the results
    """
    ...

def _complete_dag(self) -> None:
    """Complete the type mapping DAG by propagating functions along type hierarchy

    Uses topological sorting on the typeset's base graph to ensure parent type
    functions are inherited by child types.
    """
    ...
```

---

**Function get_render_map**

**Function**: Returns a mapping of data types to their corresponding render functions for report generation.

**Signature**:
```python
from ydata_profiling.model.handler import get_render_map

def get_render_map() -> Dict[str, Callable]:
    """Get the mapping of data types to render functions

    Returns:
        Dict[str, Callable]: Dictionary mapping type names to render functions
    """
    ...
```

**Returns**: `Dict[str, Callable]` - Dictionary mapping type names (as strings) to render algorithm functions

**Type-to-Render Function Mapping**:
```python
{
    "Boolean": render_algorithms.render_boolean,
    "Numeric": render_algorithms.render_real,
    "Complex": render_algorithms.render_complex,
    "Text": render_algorithms.render_text,
    "DateTime": render_algorithms.render_date,
    "Categorical": render_algorithms.render_categorical,
    "URL": render_algorithms.render_url,
    "Path": render_algorithms.render_path,
    "File": render_algorithms.render_file,
    "Image": render_algorithms.render_image,
    "Unsupported": render_algorithms.render_generic,
    "TimeSeries": render_algorithms.render_timeseries,
}
```

**Usage**: This function is used internally by the report generation system to determine which render function to use for each variable type in the profile report.


---

**Class BaseSummarizer**

**Signature**:
```python
from ydata_profiling.model.summarizer import BaseSummarizer

class BaseSummarizer(Handler):
    """A base summarizer

    Can be used to define custom summarizations
    """

    def summarize(
        self,
        config: Settings,
        series: pd.Series,
        dtype: Type[VisionsBaseType]
    ) -> dict: ...
```

**Class**: A base summarizer class that extends Handler to provide data summarization capabilities. Serves as the foundation for creating custom summarization strategies.

**Inherits From**: Handler - Inherits the type-to-function mapping and handling capabilities.

**Parameters** (__init__):
- Inherits all parameters from Handler (mapping, typeset)


**Class ProfilingSummarizer**

**Signature**:
```python
from ydata_profiling.model.summarizer import ProfilingSummarizer

class ProfilingSummarizer(BaseSummarizer):
    """A summarizer for Pandas DataFrames."""

    def __init__(self, typeset: VisionsTypeset, use_spark: bool = False): ...

    @property
    def summary_map(self) -> Dict[str, List[Callable]]: ...

    def _create_summary_map(self) -> Dict[str, List[Callable]]: ...
```

**Function**: Manages data summarization and statistical calculations for Pandas and optionally Spark DataFrames. Maps data types to appropriate summary functions.

**Parameters**:
- `typeset: VisionsTypeset` - Typeset for data type inference
- `use_spark: bool` - Whether to use Spark for distributed processing (default: False)


**Function format_summary**

**Function**: Prepares summary for export to JSON file. Converts BaseDescription to dict and formats nested structures (pandas Series, numpy arrays) into JSON-serializable formats.

**Signature**:
```python
from ydata_profiling.model.summarizer import format_summary

def format_summary(summary: Union[BaseDescription, dict]) -> dict: ...
    def fmt(v: Any) -> Any: ...
```

**Parameters**:
- `summary: Union[BaseDescription, dict]` - Summary to export, either as BaseDescription dataclass or dict

**Returns**: `dict` - Formatted summary as dictionary with all values converted to JSON-serializable types

**Function redact_summary**

**Function**: Redacts sensitive information from summary data for privacy. Redacts categorical and text variable values based on configuration settings.

**Signature**:
```python
from ydata_profiling.model.summarizer import redact_summary

def redact_summary(summary: dict, config: Settings) -> dict: ...
```

**Parameters**:
- `summary: dict` - Summary dictionary to redact
- `config: Settings` - Configuration settings with redaction flags (`config.vars.cat.redact` and `config.vars.text.redact`)

**Returns**: `dict` - Redacted summary with sensitive values replaced with `REDACTED_*` placeholders


#### Data Description and Statistics

**Class BaseAnalysis**

**Function**: Description of base analysis module of report.Overall info about report.

**Attributes**:

```python
from ydata_profiling.model.description import BaseAnalysis

@dataclass
class BaseAnalysis:
    title: str
    date_start: Union[datetime, List[datetime]]
    date_end: Union[datetime, List[datetime]]
```

**Constructor**:

```python
def __init__(self, title: str, date_start: datetime, date_end: datetime) -> None
```

**Property**:

```python
@property
def duration(self) -> Union[timedelta, List[timedelta]]:
    """Calculates duration as date_end - date_start"""
```

**Class TimeIndexAnalysis**

**Function**: Description of timeseries index analysis module of report.

**Attributes**:

```python
from ydata_profiling.model.description import TimeIndexAnalysis

@dataclass
class TimeIndexAnalysis:
    n_series: Union[int, List[int]]
    length: Union[int, List[int]]
    start: Any
    end: Any
    period: Union[float, List[float], Timedelta, List[Timedelta]]
    frequency: Union[Optional[str], List[Optional[str]]]
```

**Constructor**:

```python
def __init__(
    self,
    n_series: int,
    length: int,
    start: Any,
    end: Any,
    period: float,
    frequency: Optional[str] = None,
) -> None
```

**Class BaseDescription**

**Attributes**:

```python
@dataclass
class BaseDescription:
    """Description of DataFrame."""

    analysis: BaseAnalysis
    time_index_analysis: Optional[TimeIndexAnalysis]
    table: Any
    variables: Dict[str, Any]
    scatter: Any
    correlations: Dict[str, Any]
    missing: Dict[str, Any]
    alerts: Any
    package: Dict[str, Any]
    sample: Any
    duplicates: Any
```

**Function describe**

**Function**: Calculate the statistics for each series in this DataFrame.

**Signature**:

```python
from ydata_profiling.model.describe import describe

def describe(
    config: Settings,
    df: Union[pd.DataFrame, "pyspark.sql.DataFrame"],
    summarizer: BaseSummarizer,
    typeset: VisionsTypeset,
    sample: Optional[dict] = None,
) -> BaseDescription: ...
```

**Parameters**:
- `config: Settings` - Report Settings object
- `df: Union[pd.DataFrame, "pyspark.sql.DataFrame"]` - DataFrame to profile (pandas or PySpark)
- `summarizer: BaseSummarizer` - Summarizer object for computing statistics
- `typeset: VisionsTypeset` - Visions typeset for type inference
- `sample: Optional[dict]` - Optional custom sample dict (default: None)

**Returns**: `BaseDescription` - A BaseDescription object containing:
- `analysis: BaseAnalysis` - Report metadata including title, date_start, date_end, and duration
- `time_index_analysis: Optional[TimeIndexAnalysis]` - Time series index analysis (for time series datasets), including n_series, length, start, end, period, and frequency
- `table: Any` - Overall dataset statistics including n (row count), n_var (column count), n_cells_missing, n_duplicates, memory_size, record_size, types (type counts), etc.
- `variables: Dict[str, Any]` - Per-variable/column descriptions with detailed statistics. Keys are column names, values are dictionaries containing type-specific statistics (e.g., mean, std, quantiles for numeric; value_counts, unique for categorical)
- `scatter: Any` - Scatter plot matrix data for pairwise variable interactions
- `correlations: Dict[str, Any]` - Correlation matrices computed using different methods (pearson, spearman, kendall, phi_k, cramers, etc.)
- `missing: Dict[str, Any]` - Missing value diagrams and statistics including missing counts, matrix, bar chart, heatmap data
- `alerts: Any` - List of data quality alerts detected across all analysis modules (variables, correlations, duplicates, missing values)
- `package: Dict[str, Any]` - Package metadata containing ydata_profiling_version and ydata_profiling_config (serialized Settings)
- `sample: Any` - Sample data from the dataset including head (first rows), tail (last rows), and random samples
- `duplicates: Any` - Information about duplicate rows in the dataset

**Function get_series_descriptions**

**Function**: Get the statistics for each series in this DataFrame.

**Signature**:
```python
from ydata_profiling.model.summary import get_series_descriptions

def get_series_descriptions(
    config: Settings,
    df: Any,
    summarizer: BaseSummarizer,
    typeset: VisionsTypeset,
    pbar: tqdm,
) -> dict: ...
```

**Parameters**:
- `config: Settings` - Report Settings object
- `df: Any` - DataFrame (pandas.DataFrame or pyspark.sql.DataFrame)
- `summarizer: BaseSummarizer` - Summarizer object for variable analysis
- `typeset: VisionsTypeset` - Visions typeset for type inference
- `pbar: tqdm` - Progress bar instance

**Returns**: `dict` - Dictionary mapping column names to their statistical descriptions

**Function describe_1d**

**Function**: Computes statistical description for a single series (column). Dispatches to backend-specific implementation based on series type (pandas.Series or pyspark.sql.DataFrame).

**Signature**:

```python
from ydata_profiling.model.summary import describe_1d

def describe_1d(
    config: Settings,
    series: Any,
    summarizer: BaseSummarizer,
    typeset: VisionsTypeset,
) -> dict: ...
```

**Parameters**:
- `config: Settings` - Configuration settings for profiling
- `series: Any` - Series to describe (pandas.Series or spark DataFrame column)
- `summarizer: BaseSummarizer` - Summarizer instance for computing statistics
- `typeset: VisionsTypeset` - Typeset for type inference

**Returns**: `dict` - Dictionary containing statistical description of the series

**Raises**: `TypeError` - If series type is not supported (must be pandas.Series or spark DataFrame)


**Function get_duplicates**

**Function**: Detects and counts duplicate rows in the DataFrame.

```python
@multimethod
def get_duplicates(
    config: Settings, df: T, supported_columns: Sequence
) -> Tuple[Dict[str, Any], Optional[T]]: ...

```

#### Algorithm Implementation

**Note on Multimethod Pattern**: The following functions use the `@multimethod` decorator from the `multimethod` library. This allows multiple implementations of the same function name based on the type of the input (e.g., pandas vs Spark). The base definitions raise `NotImplementedError`, and actual implementations are registered using `.register` decorator (e.g., `@describe_counts.register` in pandas-specific modules).

**Function describe_counts**

**Function**: It is a multi dispatch function.

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_counts

@multimethod
def describe_counts(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]:
```

**Function describe_generic**

**Function**: Performs general descriptive statistics. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python

from ydata_profiling.model.summary_algorithms import describe_generic

@multimethod
def describe_generic(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]: ...
```


**Function describe_supported**

**Function**: Checks whether a variable supports specific analysis and calculates distinct/unique statistics. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_supported

@multimethod
def describe_supported(
    config: Settings, series: Any, series_description: dict
) -> Tuple[Settings, Any, dict]: ...
    
```
**Function describe_numeric_1d**

**Function**: Describes numeric/float variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_numeric_1d

@multimethod
def describe_numeric_1d(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]:
 
```

**Function describe_categorical_1d**

**Function**: Describes categorical variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_categorical_1d

@multimethod
def describe_categorical_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]: ...
```

**Function describe_boolean_1d**

**Function**: Describes boolean variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_boolean_1d

@multimethod
def describe_boolean_1d(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]: ...
```

**Function describe_date_1d**

**Function**: Describes date/datetime variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_date_1d\

@multimethod
def describe_date_1d(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]:

```

**Function describe_text_1d**

**Function**: Describes text/string variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_text_1d

@multimethod
def describe_text_1d(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict, Any]:
   
```

**Note**: This function returns a 4-tuple (including an extra element), unlike other describe functions which return 3-tuples.


**Function describe_timeseries_1d**

**Import Method**: ``

**Function**: Describes timeseries variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_timeseries_1d

@multimethod
def describe_timeseries_1d(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]:
  
```


**Function describe_url_1d**

**Function**: Describes URL-type variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_url_1d

@multimethod
def describe_url_1d(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]:

```

**Function describe_file_1d**

**Function**: Describes file-type variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_file_1d

@multimethod
def describe_file_1d(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]: ...
```

**Function describe_path_1d**

**Function**: Describes path-type variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_path_1d

@multimethod
def describe_path_1d(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]:
```

**Function describe_image_1d**

**Function**: Describes image-type variables. This is a multimethod dispatcher - actual implementations are registered per backend (pandas/Spark).

**Base Signature**:
```python
from ydata_profiling.model.summary_algorithms import describe_image_1d

@multimethod
def describe_image_1d(
    config: Settings, series: Any, summary: dict
) -> Tuple[Settings, Any, dict]: ...
    
```

**Function histogram_compute**

**Function**: Calculates the histogram data of variables.

**Signature**:

```python
from ydata_profiling.model.summary_algorithms import histogram_compute

def histogram_compute(
    config: Settings,
    finite_values: np.ndarray,
    n_unique: int,
    name: str = "histogram",
    weights: Optional[np.ndarray] = None,
) -> dict:
```

#### Table Statistics

**Function get_table_stats**

**Function**: Gets the overall statistical information of the DataFrame.

```python
from ydata_profiling.model.table import get_table_stats
@multimethod
def get_table_stats(config: Settings, df: Any, variable_stats: dict) -> dict: ...
  
```

### Expected Value Algorithm Module

#### Expected Value Generation

**Function generic_expectations**

**Function**: Generates general data quality expectations for all variable types. Creates expectations for column existence, non-null values, and uniqueness based on summary statistics.

**Signature**:
```python
from ydata_profiling.model.expectation_algorithms import generic_expectations

def generic_expectations(
    name: str, summary: dict, batch: Any, *args
) -> Tuple[str, dict, Any]:
```

**Parameters**:
- `name`: Column name
- `summary`: Summary statistics dictionary containing `n_missing` and `p_unique`
- `batch`: Great Expectations batch object
- `*args`: Additional arguments

**Returns**: Tuple of (name, summary, batch)

**Function numeric_expectations**

**Function**: Generates expectations for numeric variables. Creates expectations for numeric type validation, monotonicity (increasing/decreasing), and value range bounds based on min/max.

**Signature**:
```python
from ydata_profiling.model.expectation_algorithms import numeric_expectations

def numeric_expectations(
    name: str, summary: dict, batch: Any, *args
) -> Tuple[str, dict, Any]
```

**Parameters**:
- `name`: Column name
- `summary`: Summary statistics dictionary with keys like `monotonic_increase`, `monotonic_decrease`, `min`, `max`
- `batch`: Great Expectations batch object
- `*args`: Additional arguments

**Returns**: Tuple of (name, summary, batch)

**Function categorical_expectations**

**Function**: Generates Great Expectations for categorical variables. Creates expectations for categorical values to be in a specific set if distinct count is below thresholds (absolute: 10, relative: 0.2).

**Signature**:
```python
from ydata_profiling.model.expectation_algorithms import categorical_expectations

def categorical_expectations(
    name: str, summary: dict, batch: Any, *args
) -> Tuple[str, dict, Any]
```
**Parameters**:
- `name`: Column name
- `summary`: Summary statistics dictionary with `n_distinct`, `p_distinct`, `value_counts_without_nan`
- `batch`: Great Expectations batch object
- `*args`: Additional arguments

**Returns**: Tuple of (name, summary, batch)

**Function datetime_expectations**

**Function**: Generates expectations for datetime variables. Creates expectations for datetime values to be within min/max range with string parsing support.


**Signature**:
```python
from ydata_profiling.model.expectation_algorithms import datetime_expectations
def datetime_expectations(
    name: str, summary: dict, batch: Any, *args
) -> Tuple[str, dict, Any]
```
**Parameters**:
- `name`: Column name
- `summary`: Summary statistics dictionary with `min`, `max` datetime values
- `batch`: Great Expectations batch object
- `*args`: Additional arguments

**Returns**: Tuple of (name, summary, batch)

**Function path_expectations**

**Function**: Generates expectations for path-type variables. Currently a passthrough function with no specific expectations.

**Signature**:
```python
from ydata_profiling.model.expectation_algorithms import path_expectations

def path_expectations(
    name: str, summary: dict, batch: Any, *args
) -> Tuple[str, dict, Any]
```

**Function image_expectations**

**Function**: Generates expectations for image-type variables. Currently a passthrough function with no specific expectations.

**Signature**:
```python
from ydata_profiling.model.expectation_algorithms import image_expectations

def image_expectations(
    name: str, summary: dict, batch: Any, *args
) -> Tuple[str, dict, Any]
```

**Function url_expectations**

**Function**: Generates expectations for URL-type variables. Currently a passthrough function with no specific expectations.

**Signature**:
```python
from ydata_profiling.model.expectation_algorithms import url_expectations

def url_expectations(
    name: str, summary: dict, batch: Any, *args
) -> Tuple[str, dict, Any]
```

**Function file_expectations**

**Function**: Generates expectations for file-type variables. Currently a passthrough function with no specific expectations.

**Signature**:
```python
from ydata_profiling.model.expectation_algorithms import file_expectations

def file_expectations(
    name: str, summary: dict, batch: Any, *args
) -> Tuple[str, dict, Any]
```

### Data Quality Alerts Module

#### Alert System

**Module Docstring**:
```
Logic for alerting the user on possibly problematic patterns in the data (e.g. high number of zeros,
constant values, high correlations).
```

**Enumeration AlertType**

```python
from ydata_profiling.model.alerts import AlertType

@unique
class AlertType(Enum):=
"""Alert types"""
```

**Function**: Enumeration of alert types with 20 members, each with an automatic value and docstring:

- `CONSTANT = auto()`: """This variable has a constant value."""
- `ZEROS = auto()`: """This variable contains zeros."""
- `HIGH_CORRELATION = auto()`: """This variable is highly correlated."""
- `HIGH_CARDINALITY = auto()`: """This variable has a high cardinality."""
- `UNSUPPORTED = auto()`: """This variable is unsupported."""
- `DUPLICATES = auto()`: """This variable contains duplicates."""
- `NEAR_DUPLICATES = auto()`: """This variable contains duplicates."""
- `SKEWED = auto()`: """This variable is highly skewed."""
- `IMBALANCE = auto()`: """This variable is imbalanced."""
- `MISSING = auto()`: """This variable contains missing values."""
- `INFINITE = auto()`: """This variable contains infinite values."""
- `TYPE_DATE = auto()`: """This variable is likely a datetime, but treated as categorical."""
- `UNIQUE = auto()`: """This variable has unique values."""
- `DIRTY_CATEGORY = auto()`: """This variable is a categories with potential fuzzy values, and for that reason might incur in consistency issues."""
- `CONSTANT_LENGTH = auto()`: """This variable has a constant length."""
- `REJECTED = auto()`: """Variables are rejected if we do not want to consider them for further analysis."""
- `UNIFORM = auto()`: """The variable is uniformly distributed."""
- `NON_STATIONARY = auto()`: """The variable is a non-stationary series."""
- `SEASONAL = auto()`: """The variable is a seasonal time series."""
- `EMPTY = auto()`: """The DataFrame is empty."""

**Class Alert**

```python
from ydata_profiling.model.alerts import Alert

class Alert:
    """An alert object (type, values, column)."""

    def __init__(
        self,
        alert_type: AlertType,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        fields: Optional[Set] = None,
        is_empty: bool = False,
    )

    @property
    def alert_type_name(self) -> str: ...

    @property
    def anchor_id(self) -> Optional[str]: ...
    def fmt(self) -> str: ...
    def _get_description(self) -> str: ...
    def __repr__(self): ...
```

**Parameters** (__init__):
- `alert_type: AlertType` - The type of alert (from AlertType enum)
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `fields: Optional[Set] = None` - Optional set of fields related to the alert
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset


**Class Attributes**:

```python
_anchor_id: Optional[str] = None
```


#### 1. ConstantLengthAlert

**Signature**:
```python
from ydata_profiling.model.alerts import ConstantLengthAlert

class ConstantLengthAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ...

    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset


---

#### 2. ConstantAlert

**Constructor Signature**:
```python
from ydata_profiling.model.alerts import ConstantAlert
class ConstantAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ):
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 3. DuplicatesAlert

**Constructor Signature**:
```python
from ydata_profiling.model.alerts import DuplicatesAlert

class DuplicatesAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```
**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset


---

#### 4. NearDuplicatesAlert

**Constructor Signature**:
```python
class NearDuplicatesAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset


---

#### 5. EmptyAlert

**Constructor Signature**:
```python
class EmptyAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```
**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 6. HighCardinalityAlert

**Inheritance**: `HighCardinalityAlert(Alert)`

**Constructor Signature**:
```python
class HighCardinalityAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```
**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 7. DirtyCategoryAlert

**Inheritance**: `DirtyCategoryAlert(Alert)`

**Constructor Signature**:
```python
class DirtyCategoryAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...

```
**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset


---

#### 8. HighCorrelationAlert

**Constructor Signature**:
```python
class HighCorrelationAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 9. ImbalanceAlert

**Constructor Signature**:
```python
class ImbalanceAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset
---

#### 10. InfiniteAlert

**Constructor Signature**:
```python
class InfiniteAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```
**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---
#### 11. MissingAlert

**Constructor Signature**:
```python
class MissingAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```
**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 12. NonStationaryAlert

**Constructor Signature**:
```python
class NonStationaryAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 13. SeasonalAlert

**Constructor Signature**:
```python
class SeasonalAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ... 
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 14. SkewedAlert

**Inheritance**: `SkewedAlert(Alert)`

**Constructor Signature**:
```python
class SkewedAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ...
    def _get_description(self) -> str: ...
    
```
**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset
---

#### 15. TypeDateAlert

**Constructor Signature**:
```python

class TypeDateAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ...
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 16. UniformAlert

**Inheritance**: `UniformAlert(Alert)`

**Constructor Signature**:
```python
class UniformAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ):
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 17. UniqueAlert

**Inheritance**: `UniqueAlert(Alert)`

**Constructor Signature**:
```python
class UniqueAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ...
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 18. UnsupportedAlert

**Inheritance**: `UnsupportedAlert(Alert)`

**Constructor Signature**:
```python
class UnsupportedAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ...
    def _get_description(self) -> str: ...
```

**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 19. ZerosAlert

**Inheritance**: `ZerosAlert(Alert)`

**Constructor Signature**:
```python
class ZerosAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ...
    def _get_description(self) -> str: ...
```
**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset

---

#### 20. RejectedAlert

**Constructor Signature**:
```python
class RejectedAlert(Alert):
    def __init__(
        self,
        values: Optional[Dict] = None,
        column_name: Optional[str] = None,
        is_empty: bool = False,
    ): ...
    def _get_description(self) -> str: ...
```
**Parameters** (__init__):
- `values: Optional[Dict] = None` - Optional dictionary of alert values
- `column_name: Optional[str] = None` - Optional name of the column the alert applies to
- `is_empty: bool = False` - Boolean flag indicating if the alert is for an empty dataset


**Function check_table_alerts**

**Function**: Checks the overall dataset for alerts.

```python
from ydata_profiling.model.alerts import check_table_alerts

def check_table_alerts(table: dict) -> List[Alert]: ...
```

**Parameters**:
- `table: dict` - Overall dataset statistics dictionary

**Returns**: `List[Alert]` - A list of alerts found at the table/dataset level

---

**Function check_variable_alerts**

**Function**: Checks individual variables/columns for alerts based on their descriptions and data characteristics.

**Signature**:
```python
from ydata_profiling.model.alerts import check_variable_alerts

def check_variable_alerts(config: Settings, col: str, description: dict) -> List[Alert]: ...
```

**Parameters**:
- `config: Settings` - Report configuration settings
- `col: str` - The column name that is being checked
- `description: dict` - The series/column description dictionary containing statistics and metadata

**Returns**: `List[Alert]` - A list of Alert objects for issues detected in the variable

**Implementation Logic**:
The function checks for various types of alerts in the following order:
1. **Generic Alerts**: Applies to all variables (e.g., high missing rate)
2. **Type-Specific Alerts**:
   - If type is "Unsupported": Adds unsupported type alerts
   - Otherwise: Adds supported type alerts, then checks for:
     - **Categorical**: High cardinality, imbalance, constant length, dirty categories
     - **Numeric**: Zeros, skewness, infinite values, uniformity
     - **TimeSeries**: Non-stationarity, seasonality
     - **Boolean**: Imbalance

**Post-Processing**:
After collecting all alerts, the function updates each alert with:
- `alert.column_name = col` - Sets the column name
- `alert.values = description` - Attaches the full description for reference



**Function get_alerts**

**Function**: Main entry point to get all alerts for a dataset. Combines table alerts, variable alerts, and correlation alerts, then sorts them by alert type.

**Signature**:

```python
from ydata_profiling.model.alerts import get_alerts

def get_alerts(
    config: Settings,
    table_stats: dict,
    series_description: dict,
    correlations: dict
) -> List[Alert]
```

**Function get_alerts**

Function: Checks correlation-based alerts.

**Signature**:

```python
from ydata_profiling.model.alerts import check_correlation_alerts

def check_correlation_alerts(config: Settings, correlations: dict) -> List[Alert]:...
```
**Parameters**:

- `config`: Settings object containing configuration parameters.
- `correlations`: Dictionary of correlation statistics.

**Returns**: List of Alert objects for correlation-based issues.
**Function numeric_alerts**
Function: Checks correlation-based alerts.

**Signature**:

```python
from ydata_profiling.model.alerts import numeric_alerts

def numeric_alerts(config: Settings, summary: dict) -> List[Alert]:
```
**Parameters**:

- `config`: Settings object containing configuration parameters.
- `summary`: Dictionary of correlation statistics.

**Returns**: List of Alert objects for correlation-based issues.

**Function timeseries_alerts**
Function: Checks timeseries-based alerts.

**Signature**:

```python
from ydata_profiling.model.alerts import timeseries_alerts

def timeseries_alerts(config: Settings, summary: dict) -> List[Alert]:
```
**Parameters**:

- `config`: Settings object containing configuration parameters.
- `summary`: Dictionary of timeseries statistics.

**Returns**: List of Alert objects for timeseries-based issues.
**Function categorical_alerts**
Function: Checks categorical-based alerts.

**Signature**:

```python
from ydata_profiling.model.alerts import categorical_alerts

def categorical_alerts(config: Settings, summary: dict) -> List[Alert]:
```
**Parameters**:

- `config`: Settings object containing configuration parameters.
- `summary`: Dictionary of categorical statistics.

**Returns**: List of Alert objects for categorical-based issues.

**Function boolean_alerts**

Function: Checks boolean-based alerts.

**Signature**:

```python
from ydata_profiling.model.alerts import boolean_alerts

def boolean_alerts(config: Settings, summary: dict) -> List[Alert]:
```
**Parameters**:

- `config`: Settings object containing configuration parameters.
- `summary`: Dictionary of boolean statistics.
**Returns**: List of Alert objects for boolean-based issues.

**Function generic_alerts**
Function: Checks generic-based alerts.

**Signature**:

```python
from ydata_profiling.model.alerts import generic_alerts

def generic_alerts( summary: dict) -> List[Alert]:
```
**Parameters**:
- `summary`: Dictionary of generic statistics.

**Returns**: List of Alert objects for generic-based issues.


**Function supported_alerts**
Function: Checks correlation-based alerts.

**Signature**:

```python
from ydata_profiling.model.alerts import supported_alerts

def supported_alerts(summary: dict) -> List[Alert]:
```
**Parameters**:
- `summary`: Dictionary of generic statistics.

**Returns**: List of Alert objects for correlation-based issues.
**unsupported_alerts**
Function: Checks unsupported-based alerts.

**Signature**:

```python
from ydata_profiling.model.alerts import unsupported_alerts

def unsupported_alerts() -> List[Alert]:
```
**Parameters**:
- `summary`: Dictionary of generic statistics.

**Returns**: List of Alert objects for unsupported-based issues.

**Function alert_value**
Function: Helper to extract alert value from summary dictionary.

**Signature**:

```python
from ydata_profiling.model.alerts import alert_value

def alert_value(value: float) -> bool:
```
**Parameters**:
- `value`: Value to check for alert condition.

**Returns**: True if value meets alert condition, False otherwise.

**Function skewness_alert**
Function: Check if variable is skewed based on threshold.

**Signature**:

```python
from ydata_profiling.model.alerts import skewness_alert

def skewness_alert(v: float, threshold: int) -> bool:
```
**Parameters**:
- `v`: Skewness value of the variable.
- `threshold`: Threshold value for skewness alert.

**Returns**: True if variable is skewed, False otherwise.

**Function type_date_alert**
Function: Check if categorical variable is actually a date.

**Signature**:

```python
from ydata_profiling.model.alerts import type_date_alert

def type_date_alert(series: pd.Series) -> bool:
```
**Parameters**:
- `series`: Series of categorical values.

**Returns**: True if variable is a date, False otherwise.

### Correlation and Missing Data Module

#### Correlation Backend

**Class CorrelationBackend**

**Constructor**:

```python
from ydata_profiling.model.correlations import CorrelationBackend

class CorrelationBackend:
    """Helper class to select and cache the appropriate correlation backend (Pandas or Spark)."""

    @no_type_check
    def __init__(self, df: Sized):
        """Determine backend once and store it for all correlation computations."""
·
    def get_method(self, method_name: str):
        """Retrieve the appropriate correlation method class from the backend."""
```
**Parameters**:
- `df`: Input DataFrame.
- `method_name`: Name of the correlation method.

**Returns**: Correlation method class.


**Class Correlation**

**Signature**:
```python
from ydata_profiling.model.correlations import Correlation
class Correlation:
    _method_name: str = ""

    def compute(
        self, config: Settings, df: Sized, summary: dict, backend: CorrelationBackend
    ) -> Optional[Sized]:
        """Computes correlation using the correct backend (Pandas or Spark)."""
```
**Parameters**:
- `config`: Settings object containing configuration parameters.
- `df`: Input DataFrame.
- `summary`: Dictionary of correlation statistics.
- `backend`: CorrelationBackend object for backend selection.

**Returns**: Correlation matrix or None if not applicable.

**Class Auto**

**Signature**:
```python
from ydata_profiling.model.correlations import Auto

class Auto(Correlation):
    """Automatically selects the appropriate correlation method based on the DataFrame type."""

```
**Class Attribute**:

```python
_method_name = "auto_compute"
```

**Class Spearman**

**Signature**:
```python
from ydata_profiling.model.correlations import Spearman
class Spearman(Correlation):
```

**Class Attribute**:

```python
_method_name = "spearman_compute"
```

**Class Pearson**

**Signature**:
```python
from ydata_profiling.model.correlations import Pearson
class Pearson(Correlation):
   
```

**Class Attribute**:

```python
_method_name = "pearson_compute"
```

**Class Kendall**

**Signature**:
```python
from ydata_profiling.model.correlations import Kendall
class Kendall(Correlation):

```

**Class Attribute**:

```python
_method_name = "kendall_compute"
```

**Class Cramers**

**Signature**:
```python
from ydata_profiling.model.correlations import Cramers
class Cramers(Correlation):
    
```
**Function**: Cramér's V correlation calculation for categorical variables.

**Class Attribute**:

```python
_method_name = "cramers_compute"
```

**Class PhiK**

**Signature**:
```python
from ydata_profiling.model.correlations import PhiK
class PhiK(Correlation): ...
   
```

**Function**: Phi-K correlation calculation for mixed data types.

**Class Attribute**:

```python
_method_name = "phik_compute"
```

**Correlation Functions**

**Function warn_correlation**

**Function**: Issues a warning when correlation calculation fails. Provides instructions on how to disable the failing correlation calculation.

**Signature**:
```python
def warn_correlation(correlation_name: str, error: str) -> None
```

**Parameters**:
- `correlation_name`: Name of the correlation method that failed
- `error`: Error message from the failed calculation

**Function calculate_correlation**

**Function**: Calculates correlation coefficients between variables for selected correlation types.

**Signature**:
```python
def calculate_correlation(
    config: Settings, df: Sized, correlation_name: str, summary: dict
) -> Optional[Sized]
```
- `config`: Settings object containing configuration parameters.
- `df`: Input DataFrame.
- `correlation_name`: Name of the correlation method to calculate (one of: "auto", "pearson", "spearman", "kendall", "cramers", "phi_k")
- `summary`: summary dictionary containing variable descriptions

**Returns**: pd.DataFrame or None - The correlation matrices for the given correlation measures. Return None if correlation is empty.

---

**Function perform_check_correlation**

**Function**: Checks whether selected variables are highly correlated in the correlation matrix by comparing absolute values against a threshold.

**Signature**:
```python
from ydata_profiling.model.correlations import perform_check_correlation

def perform_check_correlation(
    correlation_matrix: pd.DataFrame, threshold: float
) -> Dict[str, List[str]]: ...
```

**Parameters**:
- correlation_matrix: pd.DataFrame - The correlation matrix for the DataFrame
- threshold: float - Correlation threshold for identifying high correlations

**Returns**: Dict[str, List[str]] - Dictionary mapping each variable to its list of highly correlated variables

**Docstring**: "Check whether selected variables are highly correlated values in the correlation matrix."

---

**Function get_active_correlations**

**Function**: Gets the list of active correlation methods from the configuration by checking which correlation methods have their calculate flag set to True.

**Signature**:
```python
from ydata_profiling.model.correlations import get_active_correlations

def get_active_correlations(config: Settings) -> List[str]: ...
```

**Parameters**:
- config: Settings - Settings object containing correlation configuration

**Returns**: List[str] - List of correlation method names that are enabled for calculation


**Function spearman_compute**

**Function**: Computes Spearman rank correlation for numeric columns.

**Signature**:
```python
from ydata_profiling.model.pandas.correlations_pandas import spearman_compute
from ydata_profiling.model.spark.correlations_spark import spearman_compute

def spearman_compute(
    config: Settings, df: pd.DataFrame, summary: dict
) -> Optional[pd.DataFrame]: ...
```

**Parameters**:
- `config: Settings` - Settings object containing configuration parameters
- `df: pd.DataFrame` - Input DataFrame
- `summary: dict` - Dictionary of correlation statistics

**Returns**: `Optional[pd.DataFrame]` - Spearman correlation matrix or None if not applicable

**Function pearson_compute**

**Function**: Computes Pearson correlation coefficient for numeric columns.

**Signature**:
```python
from ydata_profiling.model.pandas.correlations_pandas import pearson_compute
from ydata_profiling.model.spark.correlations_spark import pearson_compute

def pearson_compute(
    config: Settings, df: pd.DataFrame, summary: dict
) -> Optional[pd.DataFrame]: ...
```

**Parameters**:
- `config: Settings` - Settings object containing configuration parameters
- `df: pd.DataFrame` - Input DataFrame
- `summary: dict` - Dictionary of correlation statistics

**Returns**: `Optional[pd.DataFrame]` - Pearson correlation matrix or None if not applicable

**Function kendall_compute**

**Function**: Computes Kendall's tau correlation for numeric columns.

**Signature**:
```python
from ydata_profiling.model.pandas.correlations_pandas import kendall_compute
from ydata_profiling.model.spark.correlations_spark import kendall_compute

def kendall_compute(
    config: Settings, df: pd.DataFrame, summary: dict
) -> Optional[pd.DataFrame]: ...
```

**Parameters**:
- `config: Settings` - Settings object containing configuration parameters
- `df: pd.DataFrame` - Input DataFrame
- `summary: dict` - Dictionary of correlation statistics

**Returns**: `Optional[pd.DataFrame]` - Kendall's tau correlation matrix or None if not applicable

**Function cramers_compute**

**Function**: Computes Cramér's V correlation for categorical data.

**Signature**:
```python
from ydata_profiling.model.pandas.correlations_pandas import cramers_compute
from ydata_profiling.model.spark.correlations_spark import cramers_compute

def cramers_compute(
    config: Settings, df: pd.DataFrame, summary: dict
) -> Optional[pd.DataFrame]: ...
```

**Parameters**:
- `config: Settings` - Settings object containing configuration parameters
- `df: pd.DataFrame` - Input DataFrame
- `summary: dict` - Dictionary of correlation statistics

**Returns**: `Optional[pd.DataFrame]` - Cramér's V correlation matrix or None if not applicable

**Function phik_compute**

**Function**: Computes Phi-K correlation for mixed data types (numeric and categorical).

**Signature**:
```python
from ydata_profiling.model.pandas.correlations_pandas import phik_compute

def phik_compute(
    config: Settings, df: pd.DataFrame, summary: dict
) -> Optional[pd.DataFrame]: ...
```

**Parameters**:
- `config: Settings` - Settings object containing configuration parameters
- `df: pd.DataFrame` - Input DataFrame
- `summary: dict` - Dictionary of correlation statistics

**Returns**: `Optional[pd.DataFrame]` - Phi-K correlation matrix or None if not applicable

**Function auto_compute**

**Function**: Automatically selects appropriate correlation method based on data types.

**Signature**:
```python
from ydata_profiling.model.pandas.correlations_pandas import auto_compute

def auto_compute(
    config: Settings, df: pd.DataFrame, summary: dict
) -> Optional[pd.DataFrame]: ...
```

**Parameters**:
- `config: Settings` - Settings object containing configuration parameters
- `df: pd.DataFrame` - Input DataFrame
- `summary: dict` - Dictionary of correlation statistics

**Returns**: `Optional[pd.DataFrame]` - Correlation matrix using automatically selected method or None if not applicable

#### Missing Data Backend

**Class MissingDataBackend**

**Function**: Helper class to select and cache the appropriate missing-data backend (Pandas or Spark). Similar to CorrelationBackend, it determines the backend once and stores it for all missing data computations.

```python
class MissingDataBackend:
    """Helper class to select and cache the appropriate missing-data backend (Pandas or Spark)."""
    def __init__(self, df: Sized):
        
    def get_method(self, method_name: str) -> Callable:
              
```
**Properties**:
-`__init__`: Determine backend once and store it for all missing-data computations.
    - `df`: Input DataFrame.
-`get_method` : Retrieve the appropriate missing-data function from the backend module.
    - `method_name`: Name of the missing-data method.
    **Returns**: Corresponding missing-data function.


**Class MissingData**

**Function**: Base class for all missing data visualization methods. Provides compute() method that uses the appropriate backend.

**Signature**:
```python

rom ydata_profiling.model.missing import MissingData

class MissingData:
    _method_name: str = ""

    def compute(
        self, config: Settings, df: Sized, backend: MissingDataBackend
    ) -> Optional[Sized]:
        """Computes correlation using the correct backend (Pandas or Spark)."""
```
**Parameters**:
    - `config`: Settings object containing configuration parameters.
    - `df`: Input DataFrame.
    - `backend`: MissingDataBackend instance.

**Returns**: Correlation matrix or None if not applicable.


**Class Attribute**:

```python
_method_name: str = ""
```


**Class MissingBar**

**Function**: Compute missing value bar chart visualization.

**Signature**:
```python
from ydata_profiling.model.missing import MissingBar

class MissingBar(MissingData): ...

```

**Class Attribute**:

```python
_method_name = "missing_bar"
```

**Class MissingMatrix**

**Function**: Compute missing value matrix visualization.

**Signature**:
```python
from ydata_profiling.model.missing import MissingMatrix

class MissingMatrix(MissingData):

```

**Class Attribute**:

```python
_method_name = "missing_matrix"
```

**Class MissingHeatmap**

**Function**: Compute missing value heatmap visualization.

**Signature**:
```python
from ydata_profiling.model.missing import MissingHeatmap

class MissingHeatmap(MissingData):
    _method_name = "missing_heatmap"
```

**Class Attribute**:

```python
_method_name = "missing_heatmap"
```
**Function get_missing_active**
** Function**: Gets active missing value diagram types from config.
```python
def get_missing_active(config: Settings, table_stats: dict) -> Dict[str, Any]:
      """

    Args:
        config: report Settings object
        table_stats: The overall statistics for the DataFrame.

    Returns:

    """
```
**Parameters**:
    - `config`: report Settings object
    - `table_stats`: The overall statistics for the DataFrame.

**Returns**:
    - `Dict[str, Any]`: A dictionary of active missing value diagram types.

**Function get_missing_diagram**
** Function**: Generates missing value diagram data.
```python
def get_missing_diagram(
    config: Settings, df: pd.DataFrame, settings: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Gets the rendered diagrams for missing values.

    Args:
        config: report Settings object
        df: The DataFrame on which to calculate the missing values.
        settings: missing diagram name, caption and function

    Returns:
        A dictionary containing the base64 encoded plots for each diagram that is active in the config (matrix, bar, heatmap).
    """
```
**Parameters**:
    - `config`: report Settings object
    - `df`: The DataFrame on which to calculate the missing values.
    - `settings`: missing diagram name, caption and function

**Returns**:
    - `Optional[Dict[str, Any]]`: A dictionary containing the base64 encoded plots for each diagram that is active in the config (matrix, bar, heatmap).

**Function missing_bar**
** Function**: Gets active missing value diagram types from config.
```python
```

**Function missing_bar**
** Function**: Generates missing value bar chart (pandas/spark implementations).
```python
from ydata_profiling.model.pandas.missing_pandas import missing_bar
from ydata_profiling.model.spark.missing_spark import missing_bar 
def missing_bar(config: Settings, df: pd.DataFrame) -> str: ..

```
**Parameters**
- `config`: report Settings object
- `df`: The DataFrame on which to calculate the missing values.
**Returns**:
    - `str`: Base64 encoded plot of the missing value bar chart.
```python
from ydata_profiling.model.visualisation.plot import missing_bar 
def missing_bar(
    notnull_counts: pd.Series,
    nrows: int,
    figsize: Tuple[float, float] = (25, 10),
    fontsize: float = 16,
    labels: bool = True,
    color: Tuple[float, ...] = (0.41, 0.41, 0.41),
    label_rotation: int = 45,
) -> matplotlib.axis.Axis:
""" A bar chart visualization of the missing data."""
```
**Parameters**:
    - `notnull_counts`: Series containing the count of non-null values for each column.
    - `nrows`: Number of rows in the DataFrame.
    - `figsize`: Figure size for the plot (default: (25, 10)).
    - `fontsize`: Font size for the plot labels (default: 16).
    - `labels`: Whether to display column labels on the x-axis (default: True).
    - `color`: Color for the bars in the plot (default: (0.41, 0.41, 0.41)).
    - `label_rotation`: Rotation angle for the x-axis labels (default: 45).

**Returns**:
    - `matplotlib.axis.Axis`: Axis object for the generated plot.

**Function missing_heatmap**
** Function**: Generates missing value heatmap (pandas/spark implementations).
```python
from ydata_profiling.model.pandas.missing_pandas import missing_heatmap
from ydata_profiling.model.spark.missing_spark import missing_heatmap 
def missing_heatmap(config: Settings, df: pd.DataFrame) -> str:
   
```
**Parameters**
- `config`: report Settings object
- `df`: The DataFrame on which to calculate the missing values.
**Returns**:
    - `str`: Base64 encoded plot of the missing value bar chart.
```python
from ydata_profiling.model.visualisation.plot import missing_heatmap 
def missing_heatmap(
    corr_mat: Any,
    mask: Any,
    figsize: Tuple[float, float] = (20, 12),
    fontsize: float = 16,
    labels: bool = True,
    label_rotation: int = 45,
    cmap: str = "RdBu",
    normalized_cmap: bool = True,
    cbar: bool = True,
    ax: matplotlib.axis.Axis = None,
) -> matplotlib.axis.Axis:
"""  Presents a `seaborn` heatmap visualization of missing data correlation.
    Note that this visualization has no special support for large datasets.
"""
```
**Parameters**:
    - `corr_mat`: Correlation matrix of missing values.
    - `mask`: Mask to apply to the correlation matrix.
    - `figsize`: Figure size for the plot (default: (20, 12)).
    - `fontsize`: Font size for the plot labels (default: 16).
    - `labels`: Whether to display column labels on the x-axis (default: True).
    - `label_rotation`: Rotation angle for the x-axis labels (default: 45).
    - `cmap`: Colormap to use for the heatmap (default: "RdBu").
    - `normalized_cmap`: Whether to normalize the colormap (default: True).
    - `cbar`: Whether to display the colorbar (default: True).
    - `ax`: Axis object for the plot (default: None).

**Returns**:
    - `matplotlib.axis.Axis`: Axis object for the generated plot.


#### Handler and Discretization


**Class BaseSummarizer**

**Signature**:
```python
from ydata_profiling.model.summarizer import BaseSummarizer

class BaseSummarizer(Handler):
    """A base summarizer

    Can be used to define custom summarizations
    """

    def summarize(
        self, config: Settings, series: pd.Series, dtype: Type[VisionsBaseType]
    ) -> dict:
        """Generates the summary for a given series"""
       
```
**Parameters**:
    - `config`: report Settings object
    - `series`: The Series on which to calculate the summary.
    - `dtype`: The data type of the Series.

**Returns**:
    - `dict`: A dictionary containing the summary statistics for the Series.


**Class ProfilingSummarizer**

**Signature**:
```python
from ydata_profiling.model.summarizer import ProfilingSummarizer

class ProfilingSummarizer(BaseSummarizer):
    """A summarizer for Pandas DataFrames."""
```

**Constructor**:

```python
def __init__(self, typeset: VisionsTypeset, use_spark: bool = False):
```

**Constructor Parameters**:

- `typeset: VisionsTypeset` - Type hierarchy from visions library
- `use_spark: bool` - Whether to use Spark backend (default: False)

**Properties**:

```python
@property
def summary_map(self) -> Dict[str, List[Callable]]:
    """Allows users to modify the summary map after initialization."""
```

**Methods**:

```python
def _create_summary_map(self) -> Dict[str, List[Callable]]:
    """Creates the summary map for Pandas summarization."""
```

**Function**: Creates the summary map based on whether Spark backend is used. For each data type (Unsupported, Numeric, DateTime, Text, Categorical, Boolean, URL, Path, File, Image, TimeSeries), assigns the appropriate list of description functions.


**Returns**: `Dict[str, List[Callable]]` - Mapping from data type names to lists of processing functions

**Class DiscretizationType**

**Import Method**: `from ydata_profiling.model.pandas.discretize_pandas import DiscretizationType`
**Function**: Enumeration for discretization types (UNIFORM for equal width bins, QUANTILE for equal size bins).

**Class Discretizer**

**Function**: A class which enables the discretization of a pandas dataframe.

**Signature**:
```python
from ydata_profiling.model.pandas.discretize_pandas import Discretizer
class Discretizer:
    """
    A class which enables the discretization of a pandas dataframe.
    Perform this action when you want to convert a continuous variable
    into a categorical variable.
    """
```
**Constructor**:
```python
def __init__(
    self, method: DiscretizationType, n_bins: int = 10, reset_index: bool = False
) -> None
```

**Parameters**:
- `method: DiscretizationType` - Controls how buckets are formed (UNIFORM for equal width bins, QUANTILE for equal size bins)
- `n_bins: int` - Number of bins (default: 10)
- `reset_index: bool` - Whether to reset the index after discretization (default: False)

**Attributes**:
- `discretization_type: DiscretizationType` - The discretization method
- `n_bins: int` - Number of bins
- `reset_index: bool` - Reset index flag

**Methods**:

```python
def discretize_dataframe(self, dataframe: pd.DataFrame) -> pd.DataFrame:
    """Discretize all numerical columns in the dataframe

    Args:
        dataframe (pd.DataFrame): pandas dataframe

    Returns:
        pd.DataFrame: discretized dataframe
    """

def _discretize_column(self, column: pd.Series) -> pd.Series:
    """Discretize a single column based on discretization type"""

def _descritize_quantile(self, column: pd.Series) -> pd.Series:
    """Discretize using quantile method (equal-size bins)
    """

def _descritize_uniform(self, column: pd.Series) -> pd.Series:
    """Discretize using uniform method (equal-width bins)
    """

def _get_numerical_columns(self, dataframe: pd.DataFrame) -> List[str]:
    """Get list of numerical column names from dataframe"""
```


**Class MissingnoBarSparkPatch**

**Import Method**: `from ydata_profiling.model.spark.missing_spark import MissingnoBarSparkPatch`
**Function**: Monkey patching object that allows usage of missingno library for spark dataframes. Wraps pre-computed missing value counts to bypass missingno's DataFrame processing.

```python 
class MissingnoBarSparkPatch:
     def __init__(
        self, df: DataFrame, columns: List[str] = None, original_df_size: int = None
    ): ...
    def isnull(self) -> Any:
        """
        This patches the .isnull().sum() function called by missingno library
        """
    def sum(self) -> DataFrame:
        """
        This patches the .sum() function called by missingno library
        """
    def __len__(self) -> Optional[int]:
        """
        This patches the len(df) function called by missingno library
        """
```


### Expectations and Serialization Module

**Class ExpectationHandler**

**Class Signature**:

```python
from ydata_profiling.expectations_report import ExpectationHandler

class ExpectationHandler(Handler):
    """Default handler"""

    def __init__(self, typeset: VisionsTypeset, *args, **kwargs): ...
```

**Function**: Default handler for Great Expectations integration. Maps data types to expectation algorithm functions. The mapping includes:
- Unsupported → generic_expectations
- Text → categorical_expectations
- Categorical → categorical_expectations
- Boolean → categorical_expectations
- Numeric → numeric_expectations
- URL → url_expectations
- File → file_expectations
- Path → path_expectations
- DateTime → datetime_expectations
- Image → image_expectations

**Class ExpectationsReport**

**Class Signature**:

```python
from ydata_profiling.expectations_report import ExpectationsReport
class ExpectationsReport:

```

**Function**: Extends ProfileReport to support Great Expectations suite generation.

**Class Attributes**:

```python
config: Settings
df: Optional[pd.DataFrame] = None
```

**Property**:

```python
@property
def typeset(self) -> Optional[VisionsTypeset]:
    """Returns None (overridden in subclasses)"""
    return None
```

**Method**:

```python
def to_expectation_suite(
    self,
    suite_name: Optional[str] = None,
    data_context: Optional[Any] = None,
    save_suite: bool = True,
    run_validation: bool = True,
    build_data_docs: bool = True,
    handler: Optional[Handler] = None,
) -> Any:
    """All parameters default to True to make it easier to access the full functionality of Great Expectations
    out of the box.

    Args:
        suite_name: The name of your expectation suite
        data_context: A user-specified data context
        save_suite: Boolean to determine whether to save the suite to .json as part of the method
        run_validation: Boolean to determine whether to run validation as part of the method
        build_data_docs: Boolean to determine whether to build data docs, save the .html file, and open data docs
            in your browser
        handler: The handler to use for building expectation

    Returns:
        An ExpectationSuite
    """
```

**Class SerializeReport**

**Signature**:

```python
from ydata_profiling.serialize_report import SerializeReport

class SerializeReport:
    """Extend the report to be able to dump and load reports."""

    df = None
    config = None
    _df_hash: Optional[str] = None
    _report = None
    _description_set = None

    @property
    def df_hash(self) -> Optional[str]: ...

    def dumps(self) -> bytes: ...
    def loads(self, data: bytes) -> Union["ProfileReport", "SerializeReport"]: ...
    def dump(self, output_file: Union[Path, str]) -> None: ...
    def load(self, load_file: Union[Path, str]) -> Union["ProfileReport", "SerializeReport"]: ...
```

**Function**: Provides serialization and deserialization capabilities for ProfileReport objects, enabling saving and loading reports to/from files or byte streams for caching and reproduction purposes.

**Attributes**:

- `df` - DataFrame reference (default: None)
- `config` - Settings configuration object (default: None)
- `_df_hash: Optional[str]` - Hash of DataFrame for validation (default: None)
- `_report` - Report structure object (default: None)
- `_description_set` - Statistical description data (default: None)


### Report Generation and Rendering - Core Components

#### Formatting Tools

**Function fmt_color**

**Import Method**: `from ydata_profiling.report.formatters import fmt_color`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_color(text: str, color: str) -> str: ...
```

**Docstring**:
```
Format a string in a certain color (`<span>`).

Args:
  text: The text to format.
  color: Any valid CSS color.

Returns:
    A `<span>` that contains the colored text.
```

**Function fmt_class**

**Import Method**: `from ydata_profiling.report.formatters import fmt_class`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_class(text: str, cls: str) -> str: ...
```

**Docstring**:
```
Format a string in a certain class (`<span>`).

Args:
  text: The text to format.
  cls: The name of the class.

Returns:
    A `<span>` with a class added.
```

**Function fmt_bytesize**

**Import Method**: `from ydata_profiling.report.formatters import fmt_bytesize`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_bytesize(num: float, suffix: str = "B") -> str: ...
```

**Docstring**:
```
Change a number of bytes in a human-readable format.

Args:
  num: number to format
  suffix: (Default value = 'B')

Returns:
  The value formatted in human readable format (e.g. KiB).
```

**Function fmt_percent**

**Import Method**: `from ydata_profiling.report.formatters import fmt_percent`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_percent(value: float, edge_cases: bool = True) -> str
```

**Docstring**:
```
Format a ratio as a percentage.

Args:
    edge_cases: Check for edge cases?
    value: The ratio.

Returns:
    The percentage with 1 point precision.
```

**Function fmt_timespan**

**Import Method**: `from ydata_profiling.report.formatters import fmt_timespan`

**Decorator**: `@list_args`

**Signature**:
```python

@list_args
def fmt_timespan(num_seconds: Any, detailed: bool = False, max_units: int = 3) -> str: 
    def round_number(count: Any, keep_width: bool = False) -> str: ...
    def coerce_seconds(value: Union[timedelta, int, float]) -> float: ...
    def concatenate(items: List[str]) -> str: ...
    def pluralize(count: Any, singular: str, plural: Optional[str] = None) -> str: ...

```

**Function**: Formats time duration into human-readable format (e.g., "2 hours and 30 minutes"). Supports detailed mode with nanosecond/microsecond precision.
**Method**: 
- `round_number`: Rounds a number to a specified precision.
    - `count`: The number to round.
    - `keep_width`: Whether to keep the width of the number (default: False).
    **Returns**:
        The rounded number as a string.
- `coerce_seconds`: Converts time duration to seconds.
    - `value`: The time duration to convert.
    **Returns**:
        The time duration in seconds.
- `concatenate`: Joins items with commas and "and".
    - `items`: The items to join.
- `pluralize`: Adds plural suffix if count is not 1.
    - `count`: The count to check.
    - `singular`: The singular form of the word.
    - `plural`: The plural form of the word (default: None).

**Function fmt_numeric**

**Import Method**: `from ydata_profiling.report.formatters import fmt_numeric`

**Decorator**: `@list_args`

**Signature**:
```python
def fmt_numeric(value: float, precision: int = 10) -> str
```

**Docstring**:
```
Format any numeric value.

Args:
    value: The numeric value to format.
    precision: The numeric precision

Returns:
    The numeric value with the given precision.
```

**Function fmt_number**

**Import Method**: `from ydata_profiling.report.formatters import fmt_number`

**Decorator**: `@list_args`

**Signature**:
```python

@list_args
def fmt_number(value: int) -> str
```

**Docstring**:
```
Format any numeric value.

Args:
    value: The numeric value to format.

Returns:
    The numeric value with the given precision.
```

**Function fmt_array**

**Import Method**: `from ydata_profiling.report.formatters import fmt_array`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_array(value: np.ndarray, threshold: Any = np.nan) -> str
```

**Docstring**:
```
Format numpy arrays.

Args:
    value: Array to format.
    threshold: Threshold at which to show ellipsis

Returns:
    The string representation of the numpy array.
```

**Function fmt_monotonic**

**Import Method**: `from ydata_profiling.report.formatters import fmt_monotonic`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_monotonic(value: int) -> str
```

**Function**: Formats monotonicity value (-2 to 2) into descriptive text: "Strictly decreasing" (-2), "Decreasing" (-1), "Not monotonic" (0), "Increasing" (1), or "Strictly increasing" (2).

**Function fmt_badge**

**Import Method**: `from ydata_profiling.report.formatters import fmt_badge`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_badge(value: str) -> str
```

**Function**: Formats alert badges for HTML display by converting (N) patterns to Bootstrap badge spans.

**Function freq_table**

**Import Method**: `from ydata_profiling.report.presentation.frequency_table_utils import freq_table`

**Signature**:
```python
def freq_table(
    freqtable: Union[pd.Series, List[pd.Series]],
    n: Union[int, List[int]],
    max_number_to_print: int,
) -> Union[List[Dict[str, Any]], List[List[Dict[str, Any]]]]
```

**Docstring**:
```
Render the rows for a frequency table (value, count).

Args:
  freqtable: The frequency table.
  n: The total number of values.
  max_number_to_print: The maximum number of observations to print.

Returns:
    The rows of the frequency table.
```

**Function extreme_obs_table**

**Import Method**: `from ydata_profiling.report.presentation.frequency_table_utils import extreme_obs_table`

**Signature**:
```python
def _extreme_obs_table(
    freqtable: pd.Series, number_to_print: int, n: int
) -> List[Dict[str, Any]]: ...

def extreme_obs_table(
    freqtable: Union[pd.Series, List[pd.Series]],
    number_to_print: int,
    n: Union[int, List[int]],
) -> List[List[Dict[str, Any]]]
```

**Docstring**:
```
Similar to the frequency table, for extreme observations.

Args:
  freqtable: The (sorted) frequency table.
  number_to_print: The number of observations to print.
  n: The total number of observations.

Returns:
    The HTML rendering of the extreme observation table.
```

#### Report Component Classes

**Class CorrelationTable**

**Signature**:
```python
from ydata_profiling.report.presentation.core.correlation_table import CorrelationTable

class CorrelationTable(ItemRenderer):
    def __init__(self, name: str, correlation_matrix: pd.DataFrame, **kwargs): ...
    def __repr__(self) -> str: ...
    def render(self) -> Any: ...
```

**Function**: Generates a correlation matrix table component for displaying variable correlations in the report.

**Parameters**:

- `name: str` - Name/title of the correlation table
- `correlation_matrix: pd.DataFrame` - Pandas DataFrame containing the correlation matrix data
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Methods**:

- `__init__(self, name: str, correlation_matrix: pd.DataFrame, **kwargs)` - Initializes the CorrelationTable component with name, correlation matrix, and optional keyword arguments
- `__repr__(self) -> str` - Returns a string representation of the CorrelationTable component
- `render(self) -> Any` - Renders the correlation matrix table component for display in the report

**Class Image**

**Signature**:
```python
from ydata_profiling.report.presentation.core.image import Image

class Image(ItemRenderer):
    def __init__(
        self,
        image: str,
        image_format: ImageType,
        alt: str,
        caption: Optional[str] = None,
        **kwargs,
    ): ...
    def __repr__(self) -> str: ...
    def render(self) -> Any: ...

```

**Function**: Handles the rendering of image components in the report with support for different image formats (SVG, PNG).

**Parameters**:

- `image: str` - Image data (base64 encoded or raw)
- `image_format: ImageType` - Image format type (SVG or PNG)
- `alt: str` - Alternative text for accessibility
- `caption: Optional[str]` - Optional caption text for the image (default: None)
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer
**Methods**:

- `__init__(self, image: str, image_format: ImageType, alt: str, caption: Optional[str] = None, **kwargs)` - Initializes the Image component with image data, format, alt text, optional caption, and additional keyword arguments
- `__repr__(self) -> str` - Returns a string representation of the Image component
- `render(self) -> Any` - Renders the image component for display in the report

**Class Duplicate**

**Signature**:
```python
from ydata_profiling.report.presentation.core.duplicate import Duplicate

class Duplicate(ItemRenderer):
    def __init__(self, name: str, duplicate: pd.DataFrame, **kwargs): ...
    def __repr__(self) -> str: ...
    def render(self) -> Any: ...
```

**Function**: Renders duplicate rows report component showing duplicate data entries.

**Parameters**:

- `name: str` - Name/title of the duplicate section
- `duplicate: pd.DataFrame` - DataFrame containing duplicate rows
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Class Sample**

**Signature**:
```python
from ydata_profiling.report.presentation.core.sample import Sample

class Sample(ItemRenderer):
    def __init__(
        self, name: str, sample: pd.DataFrame, caption: Optional[str] = None, **kwargs
    ): ...
    def __repr__(self) -> str: ...
    def render(self) -> Any: ...
```

**Function**: Renders a pandas DataFrame sample component with optional caption for displaying data previews.

**Parameters**:

- `name: str` - Name/title of the sample section
- `sample: pd.DataFrame` - DataFrame sample to display
- `caption: Optional[str]` - Optional caption for the sample (default: None)
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer
**Methods**:

- `__init__(self, name: str, sample: pd.DataFrame, caption: Optional[str] = None, **kwargs)` - Initializes the Sample component with name, sample DataFrame, optional caption, and additional keyword arguments
- `__repr__(self) -> str` - Returns a string representation of the Sample component
- `render(self) -> Any` - Renders the sample component for display in the report

**Class Variable**

**Signature**:
```python
from ydata_profiling.report.presentation.core.variable import Variable

class Variable(ItemRenderer):
    def __init__(
        self,
        top: Renderable,
        bottom: Optional[Renderable] = None,
        ignore: bool = False,
        **kwargs,
    ): ...
    def __str__(self): ...
    def __repr__(self): ...
    def render(self) -> Any: ...
    @classmethod
    def convert_to_class(cls, obj: Renderable, flv: Callable) -> None: ...
```

**Function**: Represents a variable section with top and optional bottom renderable components for structured variable information display.

**Parameters**:

- `top: Renderable` - Top section renderable component (required)
- `bottom: Optional[Renderable]` - Bottom section renderable component (default: None)
- `ignore: bool` - Whether to ignore this variable in rendering (default: False)
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Class VariableInfo**

**Signature**:
```python
from ydata_profiling.report.presentation.core.variable_info import VariableInfo

class VariableInfo(ItemRenderer):
    def __init__(
        self,
        anchor_id: str,
        var_name: str,
        var_type: str,
        alerts: List[Alert],
        description: str,
        style: Style,
        **kwargs
    ): ...
    def __repr__(self) -> str: ...
    def render(self) -> Any: ...

```

**Function**: Renders variable metadata including anchor_id, name, type, alerts, description, and style information.

**Parameters**:

- `anchor_id: str` - HTML anchor ID for linking to this variable
- `var_name: str` - Variable name
- `var_type: str` - Variable type (e.g., Numeric, Categorical)
- `alerts: List[Alert]` - List of data quality alerts for this variable
- `description: str` - Variable description text
- `style: Style` - Style configuration for rendering
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Methods**:

- `__init__(self, anchor_id: str, var_name: str, var_type: str, alerts: List[Alert], description: str, style: Style, **kwargs)` - Initializes the VariableInfo component with anchor_id, name, type, alerts, description, style, and additional keyword arguments
- `__repr__(self) -> str` - Returns a string representation of the VariableInfo component
- `render(self) -> Any` - Renders the variable metadata component for display in the report

**Class Table**

**Signature**:
```python
from ydata_profiling.report.presentation.core.table import Table

class Table(ItemRenderer):
    def __init__(
        self,
        rows: Sequence,
        style: Style,
        name: Optional[str] = None,
        caption: Optional[str] = None,
        **kwargs
    ): ...
    def __repr__(self) -> str: ...
    def render(self) -> Any: ...
```

**Function**: Generic table renderer with rows, style, name, and optional caption for displaying tabular data.

**Parameters**:

- `rows: Sequence` - Sequence of table rows data
- `style: Style` - Style configuration for table rendering
- `name: Optional[str]` - Optional table name/title (default: None)
- `caption: Optional[str]` - Optional table caption (default: None)
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Class Scores**

**Signature**:
```python
from ydata_profiling.report.presentation.core.scores import Scores

class Scores(ItemRenderer):
    def __init__(
        self,
        items: List[Dict],
        overall_score: float,
        style: Style,
        name: Optional[str],
        **kwargs
    ): ...
    def __repr__(self) -> str: ...
    def render(self) -> Any: ...
```

**Function**: Renders quality/profiling scores with items list, overall score, name, and style configuration.

**Parameters**:

- `items: List[Dict]` - List of individual score items with details
- `overall_score: float` - Overall quality/profiling score (0.0 to 1.0)
- `style: Style` - Style configuration for scores rendering
- `name: Optional[str]` - Optional scores section name
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Methods**:

- `__init__(self, items: List[Dict], overall_score: float, style: Style, name: Optional[str], **kwargs)` - Initializes the Scores component with items list, overall score, style, name, and additional keyword arguments
- `__repr__(self) -> str` - Returns a string representation of the Scores component
- `render(self) -> Any` - Renders the quality/profiling scores component for display in the report

**Class ToggleButton**

**Signature**:
```python
from ydata_profiling.report.presentation.core.toggle_button import ToggleButton

class ToggleButton(ItemRenderer):
    def __init__(self, text: str, **kwargs): ...
    def __repr__(self) -> str: ...
    def render(self) -> Any: ...
```

**Function**: Simple toggle button component with text label for collapsible sections in the report.

**Parameters**:

- `text: str` - Button text label
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Methods**:

- `__init__(self, text: str, **kwargs)` - Initializes the ToggleButton component with text label and additional keyword arguments
- `__repr__(self) -> str` - Returns a string representation of the ToggleButton component
- `render(self) -> Any` - Renders the toggle button component for display in the report

#### Presentation Core Classes

**Base Classes**

**Detailed Base Class Documentation**

**Class Renderable**

**Signature**:
```python
from ydata_profiling.report.presentation.core.renderable import Renderable
class Renderable(ABC):
    def __init__(
        self,
        content: Dict[str, Any],
        name: Optional[str] = None,
        anchor_id: Optional[str] = None,
        classes: Optional[str] = None,
    ):
```

**Parameters**:
- `content: Dict[str, Any]` - Content dictionary containing the data to render
- `name: Optional[str]` - Optional name for the renderable (default: None)
- `anchor_id: Optional[str]` - Optional HTML anchor ID (default: None)
- `classes: Optional[str]` - Optional CSS classes (default: None)

**Properties**:
```python
@property
def name(self) -> str:
    """Returns the name from content dictionary"""

@property
def anchor_id(self) -> str:
    """Returns the anchor_id from content dictionary"""

@property
def classes(self) -> str:
    """Returns the classes from content dictionary"""
```

**Methods**:
```python
@abstractmethod
def render(self) -> Any:
    """Abstract method to render the component. Must be implemented by subclasses."""
    pass

def __str__(self) -> str:
    """Returns the class name as string representation"""
    return self.__class__.__name__

@classmethod
def convert_to_class(cls, obj: "Renderable", flavour_func) -> None:
    """Converts an object to this class. Used for flavour conversion."""
    obj.__class__ = cls
```

**Class ItemRenderer**

**Signature**:
```python
from ydata_profiling.report.presentation.core.item_renderer import ItemRenderer

class ItemRenderer(Renderable, ABC):
    def __init__(
        self,
        item_type: str,
        content: dict,
        name: Optional[str] = None,
        anchor_id: Optional[str] = None,
        classes: Optional[str] = None,
    ):
```

**Class**: An abstract base class that extends Renderable to provide item-specific rendering functionality. Used as a base for various report components that need type identification.

**Inherits From**: Renderable, ABC - Combines renderable functionality with abstract base class pattern.

**Parameters**:
- `item_type: str` - Type identifier for the item (e.g., "report", "section", "dropdown", "table"). This distinguishes different renderer types in the presentation layer.
- `content: dict` - Content dictionary containing the data to render (passed to Renderable parent)
- `name: Optional[str]` - Optional name for the item (default: None)
- `anchor_id: Optional[str]` - Optional HTML anchor ID for navigation (default: None)
- `classes: Optional[str]` - Optional CSS classes for styling (default: None)

**Attributes**:
- `item_type: str` - Stores the type identifier after initialization

**Usage**: ItemRenderer serves as a base class for specific renderer implementations like Root, Container, Dropdown, etc. It adds type information to the basic Renderable interface.

**Class Dropdown**

**Signature**:
```python
from ydata_profiling.report.presentation.core.dropdown import Dropdown

class Dropdown(ItemRenderer):
```

**Class**: A dropdown component for displaying collapsible content in the report. Extends ItemRenderer with dropdown-specific functionality.

**Inherits From**: ItemRenderer - Inherits type-based rendering capabilities.

**Parameters**:
- `name: str` - Display name for the dropdown
- `id: str` - Unique identifier for the dropdown element
- `items: list` - List of items to display in the dropdown menu
- `item: Container` - Container object holding the dropdown content
- `anchor_id: str` - HTML anchor ID for navigation links
- `classes: list` - List of CSS class names for styling
- `is_row: bool` - Whether to display as a row layout
- `**kwargs` - Additional keyword arguments passed to ItemRenderer

**Methods**:

```python
def __init__(
    self,
    name: str,
    id: str,
    items: list,
    item: Container,
    anchor_id: str,
    classes: list,
    is_row: bool,
    **kwargs
):
    """Initialize Dropdown with content and display settings

    Args:
        name: Display name for the dropdown
        id: Unique identifier for the dropdown element
        items: List of items to display in the dropdown menu
        item: Container object holding the dropdown content
        anchor_id: HTML anchor ID for navigation links
        classes: List of CSS class names for styling
        is_row: Whether to display as a row layout
        **kwargs: Additional keyword arguments passed to ItemRenderer
    """
    ...

def render(self) -> Any:
    """Abstract method for rendering the dropdown

    Raises:
        NotImplementedError: Implementation is backend-specific (e.g., HTML, JSON)
    """
    ...

def __repr__(self) -> str:
    """Return string representation

    Returns:
        str: "Dropdown"
    """
    ...

@classmethod
def convert_to_class(cls, obj: Renderable, flv: Callable) -> None:
    """Convert a Renderable object to Dropdown class

    Args:
        obj: Renderable object to convert
        flv: Flavour conversion function to apply to nested items recursively
    """
    ...
```

**Content Structure**: The content dictionary passed to parent includes:
- name: dropdown display name
- id: unique identifier
- items: list of dropdown items
- item: Container with content
- anchor_id: navigation anchor
- classes: space-joined CSS classes string
- is_row: row layout flag



**Class Root**

**Signature**:
```python
from ydata_profiling.report.presentation.core.root import Root
class Root(ItemRenderer):
    """
    Wrapper for the report.
    """

    def __init__(
        self, name: str, body: Renderable, footer: Renderable, style: Style, **kwargs
    ):
```

**Parameters**:
- `name: str` - Report name/title
- `body: Renderable` - Main content of the report (body section)
- `footer: Renderable` - Footer content of the report
- `style: Style` - Style configuration object
- `**kwargs` - Additional keyword arguments

**Description**: Root is the top-level wrapper class for the entire profiling report. It contains the main body, footer, and style configuration. The Root class extends ItemRenderer with item_type set to "report".

**Methods**:
```python
def __repr__(self) -> str:
    """Returns 'Root' as the string representation"""
    return "Root"

def render(self, **kwargs) -> Any:
    """Render method that raises NotImplementedError.
    Actual rendering is handled by flavour-specific subclasses."""
    raise NotImplementedError()

@classmethod
def convert_to_class(cls, obj: Renderable, flv: Callable) -> None:
    """Converts object to Root class and applies flavour conversion to body and footer.

    Args:
        obj: The Renderable object to convert
        flv: Flavour conversion function to apply to nested components
    """
    obj.__class__ = cls
    if "body" in obj.content:
        flv(obj.content["body"])
    if "footer" in obj.content:
        flv(obj.content["footer"])
```

**Core Presentation Components**

**Import Method**: `from ydata_profiling.report.presentation.core import [ClassName]`

**Class Alerts**

**Signature**:
```python
from ydata_profiling.report.presentation.core.alerts import Alerts

class Alerts(ItemRenderer):
    def __init__(
        self,
        alerts: Union[List[Alert], Dict[str, List[Alert]]],
        style: Style,
        **kwargs
    ): ...
```

**Class**: Renders alert notifications from Alert objects or dictionary with style configuration.

**Parameters**:
- `alerts: Union[List[Alert], Dict[str, List[Alert]]]` - List of Alert objects or dictionary mapping alert types to lists of alerts
- `style: Style` - Style configuration object for rendering alerts
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Methods**:
```python
def __repr__(self) -> str:
    """Returns string representation 'Alerts'"""
    ...

def render(self) -> Any:
    """Abstract method to render alerts. Must be implemented by subclasses."""
    ...
```

---

**Class Collapse**

**Signature**:
```python
from ydata_profiling.report.presentation.core.collapse import Collapse

class Collapse(ItemRenderer):
    def __init__(
        self,
        button: ToggleButton,
        item: Renderable,
        **kwargs
    ): ...
```

**Class**: Collapsible container that wraps a ToggleButton and a Renderable item for expandable/collapsible UI.

**Parameters**:
- `button: ToggleButton` - Toggle button component for collapse control
- `item: Renderable` - Renderable item to be shown/hidden
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Methods**:
```python
def __repr__(self) -> str:
    """Returns string representation 'Collapse'"""
    ...

def render(self) -> Any:
    """Abstract method to render collapse. Must be implemented by subclasses."""
    ...

@classmethod
def convert_to_class(cls, obj: Renderable, flv: Callable) -> None:
    """Converts an object to this class and applies flavour to button and item."""
    ...
```

---

**Class Container**

**Signature**:
```python
from ydata_profiling.report.presentation.core.container import Container

class Container(Renderable):
    def __init__(
        self,
        items: Sequence[Renderable],
        sequence_type: str,
        nested: bool = False,
        name: Optional[str] = None,
        anchor_id: Optional[str] = None,
        classes: Optional[str] = None,
        oss: Optional[bool] = None,
        **kwargs
    ): ...
```

**Class**: Generic container for sequences of Renderable items. Supports multiple sequence types (list, tabs, accordion, grid, sections, etc.).

**Parameters**:
- `items: Sequence[Renderable]` - Sequence of Renderable items to be contained
- `sequence_type: str` - Type of sequence layout (e.g., "list", "tabs", "accordion", "grid")
- `nested: bool` - Whether this container is nested within another container (default: False)
- `name: Optional[str]` - Optional name for the container (default: None)
- `anchor_id: Optional[str]` - Optional HTML anchor ID (default: None)
- `classes: Optional[str]` - Optional CSS classes (default: None)
- `oss: Optional[bool]` - Optional OSS flag (default: None)
- `**kwargs` - Additional keyword arguments for content

**Properties**:
```python
sequence_type: str
    """Type of sequence layout for the container"""
```

**Methods**:
```python
def __str__(self) -> str:
    """Returns detailed string representation with contained items"""
    ...

def __repr__(self) -> str:
    """Returns string representation 'Container' or 'Container(name={name})'"""
    ...

def render(self) -> Any:
    """Abstract method to render container. Must be implemented by subclasses."""
    ...

@classmethod
def convert_to_class(cls, obj: Renderable, flv: Callable) -> None:
    """Converts an object to this class and applies flavour to all items."""
    ...
```
---

**Class FrequencyTableSmall**

**Signature**:
```python
from ydata_profiling.report.presentation.core.frequency_table_small import FrequencyTableSmall

class FrequencyTableSmall(ItemRenderer):
    def __init__(
        self,
        rows: List[Any],
        redact: bool,
        **kwargs
    ): ...
```

**Class**: Renders a compact frequency table with rows data and redaction support.

**Parameters**:
- `rows: List[Any]` - List of row data for the frequency table
- `redact: bool` - Whether to redact sensitive values in the table
- `**kwargs` - Additional keyword arguments passed to parent ItemRenderer

**Methods**:
```python
def __repr__(self) -> str:
    """Returns string representation 'FrequencyTableSmall'"""
    ...

def render(self) -> Any:
    """Abstract method to render frequency table. Must be implemented by subclasses."""
    ...
```

#### HTML Rendering

    HTML rendering:

**HTML Flavor Classes**

Each HTML flavour renderer subclasses the core presentation component with the same responsibility and overrides `render()` to produce an HTML fragment using the shared Jinja2 template environment.

**Class HTMLAlerts**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.alerts import HTMLAlerts`

**Signature**:
```python
class HTMLAlerts(Alerts):
    def render(self) -> str:
```

**Description**: Renders alert blocks with Jinja2 template `alerts.html`, applying styles from `get_alert_styles()`.
**Return**: 
- `str` - Rendered HTML string for alert blocks

**Class HTMLCollapse**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.collapse import HTMLCollapse`

**Signature**:
```python
class HTMLCollapse(Collapse):
    def render(self) -> str:
```

**Description**: Wraps a toggle button and nested content, rendering `collapse.html`.

**Return**: 
- `str` - Rendered HTML string for the collapse element

**Class HTMLContainer**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.container import HTMLContainer`

**Signature**:
```python
class HTMLContainer(Container):
    def render(self) -> str:
```

**Description**: Dispatches to sequence-specific templates (`sequence/list.html`, `sequence/tabs.html`, `sequence/grid.html`, etc.) based on `self.sequence_type`, raising `ValueError` for unknown types.

**Return**: 
- `str` - Rendered HTML string for the container element

**Class HTMLCorrelationTable**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.correlation_table import HTMLCorrelationTable`

**Signature**:
```python
class HTMLCorrelationTable(CorrelationTable):
    def render(self) -> str:
```

**Description**: Converts the correlation DataFrame to a styled HTML table (3 decimal places) before rendering `correlation_table.html`.
**Return**: 
- `str` - Rendered HTML string for the correlation table element

**Class HTMLDropdown**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.dropdown import HTMLDropdown`

**Signature**:
```python
class HTMLDropdown(Dropdown):
    def render(self) -> str:
```

**Description**: Emits the dropdown selector markup via `dropdown.html`.

**Return**: 
- `str` - Rendered HTML string for the dropdown element

**Class HTMLDuplicate**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.duplicate import HTMLDuplicate`

**Signature**:
```python
class HTMLDuplicate(Duplicate):
    def render(self) -> str:
```

**Description**: Uses helper `to_html(df: pd.DataFrame) -> str` to format duplicate rows and renders `duplicate.html`, inserting an explicit empty-state row when needed.

**Return**: 
- `str` - Rendered HTML string for the duplicate element

**Class HTMLFrequencyTableSmall**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.frequency_table_small import HTMLFrequencyTableSmall`

**Signature**:
```python
class HTMLFrequencyTableSmall(FrequencyTableSmall):
    def render(self) -> str:
```

**Description**: Iterates over batched row sets, rendering `frequency_table_small.html` for each batch and concatenating the fragments.
**Return**: 
- `str` - Rendered HTML string for the frequency table element

**Class HTMLRoot**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.root import HTMLRoot`

**Signature**:
```python
class HTMLRoot(Root):
    def render(self, **kwargs) -> str:
```

**Description**: Builds navigation items from section anchors and renders the top-level `report.html`, forwarding extra keyword arguments to the Jinja context.
**Return**: 
- `str` - Rendered HTML string for the root element

**Class HTMLSample**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.sample import HTMLSample`

**Signature**:
```python
class HTMLSample(Sample):
    def render(self) -> str:
```

**Description**: Converts the sample DataFrame to `<table>` markup and injects it into `sample.html`.

**Class HTMLScores**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.scores import HTMLScores`

**Signature**:
```python
class HTMLScores(Scores):
    def render(self) -> str:
```

**Description**: Renders score summaries through the `scores.html` template.
**Return**: 
- `str` - Rendered HTML string for the scores element

**Class HTMLTable**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.table import HTMLTable`

**Signature**:
```python
class HTMLTable(Table):
    def render(self) -> str:
```

**Description**: Renders generic tabular content with `table.html`.

**Return**: 
- `str` - Rendered HTML string for the table element

**Class HTMLToggleButton**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.toggle_button import HTMLToggleButton`

**Signature**:
```python
class HTMLToggleButton(ToggleButton):
    def render(self) -> str:
```

**Description**: Produces toggle button markup via `toggle_button.html`.

**Return**: 
- `str` - Rendered HTML string for the toggle button element

**Class HTMLVariable**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.variable import HTMLVariable`

**Signature**:
```python
class HTMLVariable(Variable):
    def render(self) -> str:
```

**Description**: Renders the combined variable section using `variable.html`.
**Return**: 
- `str` - Rendered HTML string for the variable element

**Class HTMLVariableInfo**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.variable_info import HTMLVariableInfo`

**Signature**:
```python
class HTMLVariableInfo(VariableInfo):
    def render(self) -> str:
```

**Description**: Formats variable metadata cards through `variable_info.html`.
**Return**: 
- `str` - Rendered HTML string for the variable info element
**
**Class HTMLHTML**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.html import HTMLHTML`

**Signature**:
```python
class HTMLHTML(HTML):
    def render(self) -> str:
```

**Description**: Returns the raw HTML payload stored in `self.content["html"]` without additional templating.
**Return**: 
- `str` - Rendered HTML string for the HTML element

**Class HTMLImage**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.image import HTMLImage`

**Signature**:
```python
class HTMLImage(Image):
    def render(self) -> str:
```

**Description**: Renders image components using the `diagram.html` template (supports captions and alternate text).
**Return**: 
- `str` - Rendered HTML string for the image element

**Class HTMLFrequencyTable**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.frequency_table import HTMLFrequencyTable`

**Signature**:
```python
class HTMLFrequencyTable(FrequencyTable):
    def render(self) -> str:
```

**Description**: Handles single or batched frequency rows; when rows are nested lists it renders multiple `frequency_table.html` fragments and concatenates them.
**Return**: 
- `str` - Rendered HTML string for the frequency table element

**Flavour Functions**

**Function register_flavour**

**Import Method**: `from ydata_profiling.report.presentation.flavours.flavours import register_flavour`

**Signature**:
```python
def register_flavour(name: str, mapping: dict) -> None:
```

**Parameters**:
- `name`: Flavour identifier (for example `"html"` or `"widget"`).
- `mapping`: Dictionary mapping core `Renderable` subclasses to their flavour-specific renderer classes.

**Returns**: `None`. Registers the mapping in the module-level `_FLAVOUR_REGISTRY`.

**Function get_flavour_mapping**

**Import Method**: `from ydata_profiling.report.presentation.flavours.flavours import get_flavour_mapping`

**Signature**:
```python
def get_flavour_mapping(name: str) -> dict:
```

**Parameters**:
- `name`: Flavour identifier to retrieve.

**Returns**: The renderer mapping registered under `name`. Raises `ValueError` if the flavour is unknown.

**Function apply_renderable_mapping**

**Import Method**: `from ydata_profiling.report.presentation.flavours.flavours import apply_renderable_mapping`

**Signature**:
```python
def apply_renderable_mapping(
    mapping: dict,
    structure: Renderable,
    flavour_func,
) -> None:
```

**Parameters**:
- `mapping`: Renderer mapping providing a `convert_to_class` callable for each core component type.
- `structure`: Root or nested `Renderable` instance to convert.
- `flavour_func`: Recursive conversion function (`HTMLReport` or `WidgetReport`) passed to `convert_to_class`.

**Returns**: `None`. Mutates `structure` in-place to replace each node with its flavour-specific variant.

**Function HTMLReport**

**Import Method**: `from ydata_profiling.report.presentation.flavours.flavours import HTMLReport`

**Signature**:
```python
def HTMLReport(structure: Root) -> Root:
```

**Parameters**:
- `structure`: Report `Root` generated by the core presentation layer.

**Returns**: The same `Root` instance after conversion to HTML renderers. Imports `flavour_html` to ensure mappings are registered before conversion.

**Function WidgetReport**

**Import Method**: `from ydata_profiling.report.presentation.flavours.flavours import WidgetReport`

**Signature**:
```python
def WidgetReport(structure: Root) -> Root:
```

**Parameters**:
- `structure`: Report `Root` to convert to ipywidgets flavour.

**Returns**: The converted `Root`. Lazily imports `flavour_widget` to populate the widget mapping before applying it.

#### Widget Rendering

#### Widget Flavour Classes

**Class WidgetAlerts**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.alerts import WidgetAlerts

class WidgetAlerts(Alerts):
    def render(self) -> widgets.GridBox: ...
```

**Function**: Renders alerts as ipywidgets with styled alert buttons in a grid layout. Each alert is displayed with its corresponding button style based on alert type.

**Return**: 
- `widgets.GridBox` - Rendered ipywidget grid box for the alerts element

**Class WidgetCollapse**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.collapse import WidgetCollapse

class WidgetCollapse(Collapse):
    def render(self) -> widgets.VBox: ...
```

**Function**: Renders collapsible widget sections with toggle functionality. Supports different collapse behaviors for correlation and variable sections.

**Return**: 
- `widgets.VBox` - Rendered ipywidget vertical box for the collapse element

**Class WidgetContainer**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.container import WidgetContainer

class WidgetContainer(Container):
    def render(self) -> widgets.Widget: ...
```

**Function**: Renders various sequence types as ipywidgets including VBox, Tab, Accordion, and GridBox layouts. Supports list, named_list, tabs, sections, select, accordion, grid, and batch_grid sequence types.

**Return**: 
- `widgets.Widget` - Rendered ipywidget for the container element

**Class WidgetCorrelationTable**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.correlation_table import WidgetCorrelationTable

class WidgetCorrelationTable(CorrelationTable):
    def render(self) -> widgets.VBox: ...
```

**Function**: Renders correlation matrix in an Output widget with name label using VBox layout. Displays correlation data in interactive widget format.

**Return**: 
- `widgets.VBox` - Rendered ipywidget vertical box for the correlation table element

**Class WidgetDropdown**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.dropdown import WidgetDropdown

class WidgetDropdown(Dropdown):
    def render(self) -> widgets.VBox: ...
```

**Function**: Creates interactive dropdown widget with synchronized item selection and display functionality. Allows users to switch between different views.

**Return**: 
- `widgets.VBox` - Rendered ipywidget vertical box for the dropdown element

**Class WidgetDuplicate**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.duplicate import WidgetDuplicate

class WidgetDuplicate(Duplicate):
    def render(self) -> widgets.VBox: ...
```

**Function**: Displays duplicate DataFrame in an Output widget with name header using VBox layout. Shows duplicate rows in an interactive format.

**Return**: 
- `widgets.VBox` - Rendered ipywidget vertical box for the duplicate element

**Class WidgetFrequencyTable**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.frequency_table import WidgetFrequencyTable

class WidgetFrequencyTable(FrequencyTable):
    def render(self) -> widgets.VBox: ...
```

**Function**: Renders frequency table as ipywidgets with progress bars indicating value frequencies. Displays categorical data distribution visually.

**Return**: 
- `widgets.VBox` - Rendered ipywidget vertical box for the frequency table element

**Class WidgetFrequencyTableSmall**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.frequency_table_small import WidgetFrequencyTableSmall

class WidgetFrequencyTableSmall(FrequencyTableSmall):
    def render(self) -> widgets.HBox: ...
```

**Function**: Renders compact frequency table as HBox items with progress bars. Optimized for displaying smaller frequency distributions.

**Return**: 
- `widgets.HBox` - Rendered ipywidget horizontal box for the frequency table small element

**Class WidgetHTML**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.html import WidgetHTML

class WidgetHTML(HTML):
    def render(self) -> widgets.HTML: ...
```

**Function**: Converts HTML content to ipywidgets.HTML or returns widget directly. Handles HTML rendering within widget framework.

**Return**: 
- `widgets.HTML` - Rendered ipywidget HTML for the HTML element

**Class WidgetImage**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.image import WidgetImage

class WidgetImage(Image):
    def render(self) -> widgets.Widget: ...
```

**Function**: Renders images as ipywidgets with format support for SVG and PNG, and optional caption. Handles image display with proper sizing and formatting.

**Return**: 
- `widgets.Widget` - Rendered ipywidget for the image element

**Class WidgetRoot**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.root import WidgetRoot

class WidgetRoot(Root):
    def render(self) -> widgets.VBox: ...
```

**Function**: Combines body and footer into a VBox widget for complete report display. Top-level container for the entire widget-based report.

**Return**: 
- `widgets.VBox` - Rendered ipywidget vertical box for the root element

**Class WidgetSample**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.sample import WidgetSample

class WidgetSample(Sample):
    def render(self) -> widgets.VBox: ...
```

**Function**: Displays sample DataFrame in an Output widget with name header using VBox layout. Shows data preview in interactive format.

**Return**: 
- `widgets.VBox` - Rendered ipywidget vertical box for the sample element

**Class WidgetTable**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.table import WidgetTable

class WidgetTable(Table):
    def render(self) -> widgets.GridspecLayout: ...
```

**Function**: Renders table rows as GridspecLayout with name/value pairs. Displays tabular data in a structured grid format.

**Return**: 
- `VBox` - Rendered ipywidget vertical box for the table element

**Class WidgetToggleButton**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.toggle_button import WidgetToggleButton

class WidgetToggleButton(ToggleButton):
    def render(self) -> widgets.HBox: ...
```

**Function**: Creates styled ToggleButton widget with flex layout. Provides interactive toggle functionality for collapsible sections.

**Return**: 
- `widgets.HBox` - Rendered ipywidget horizontal box for the toggle button element

**Class WidgetVariable**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.variable import WidgetVariable

class WidgetVariable(Variable):
    def render(self) -> widgets.VBox: ...
```

**Function**: Combines top and optional bottom renderable items in VBox layout. Displays variable information with expandable sections.

**Return**: 
- `widgets.VBox` - Rendered ipywidget vertical box for the variable element

**Class WidgetVariableInfo**

**Signature**:
```python
from ydata_profiling.report.presentation.flavours.widget.variable_info import WidgetVariableInfo

class WidgetVariableInfo(VariableInfo):
    def render(self) -> widgets.HTML: ...
```

**Function**: Renders variable info as ipywidgets.HTML by templating and wrapping. Displays variable metadata including name, type, and alerts.

**Return**: 
- `widgets.HTML` - Rendered ipywidget HTML for the variable info element

### Visualization Module

#### Internal Plotting Functions

**Function _plot_word_cloud**

**Function**: Generates word cloud visualization from frequency data.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _plot_word_cloud

def _plot_word_cloud(
    config: Settings,
    series: Union[pd.Series, List[pd.Series]],
    figsize: tuple = (6, 4),
) -> plt.Figure: ...
```

**Function _plot_histogram**

**Function**: Plots histogram visualization with support for variable bin sizes and date formatting.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _plot_histogram

def _plot_histogram(
    config: Settings,
    series: np.ndarray,
    bins: Union[int, np.ndarray],
    figsize: tuple = (6, 4),
    date: bool = False,
    hide_yaxis: bool = False,
) -> plt.Figure: ...
```

**Return**: 
- `plt.Figure` - Matplotlib figure object for the word cloud visualization

**Function _plot_pie_chart**

**Function**: Plots a pie chart for categorical data distribution.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _plot_pie_chart

def _plot_pie_chart(
    data: pd.Series, colors: List, hide_legend: bool = False
) -> Tuple[plt.Axes, matplotlib.legend.Legend]:
```

**Function _plot_stacked_barh**

**Function**: Plots a stacked horizontal bar chart for visualizing proportions.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _plot_stacked_barh

def _plot_stacked_barh(
    data: pd.Series, colors: List, hide_legend: bool = False
) -> Tuple[plt.Axes, matplotlib.legend.Legend]:
```
`
**Return**: 
- `Tuple[plt.Axes, matplotlib.legend.Legend]` - Matplotlib axes object for the stacked bar chart and legend handler

**Function _prepare_heatmap_data**

**Function**: Prepares and processes data for heatmap visualization.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _prepare_heatmap_data

def _prepare_heatmap_data(
    dataframe: pd.DataFrame,
    entity_column: str,
    sortby: Optional[Union[str, list]] = None,
    max_entities: int = 5,
    selected_entities: Optional[List[str]] = None,
) -> pd.DataFrame:
```
**Parameters**:
- `dataframe` (pd.DataFrame): Input DataFrame containing the data
- `entity_column` (str): Name of the column to be used as entities for heatmap
- `sortby` (Optional[Union[str, list]]): Column(s) to sort entities by. Default is None.
- `max_entities` (int): Maximum number of entities to include in the heatmap. Default is 5.
- `selected_entities` (Optional[List[str]]): List of specific entities to include. Default is None.

**Return**: 
- `pd.DataFrame` - Processed DataFrame ready for heatmap visualization

**Function _create_timeseries_heatmap**

**Function**: Creates a time series heatmap visualization for temporal patterns.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _create_timeseries_heatmap

def _create_timeseries_heatmap(
    df: pd.DataFrame,
    figsize: Tuple[int, int] = (12, 5),
    color: str = "#337ab7",
) -> plt.Axes:
```
**Parameters**:
- `df` (pd.DataFrame): Input DataFrame containing time series data
- `figsize` (Tuple[int, int]): Figure size for the heatmap. Default is (12, 5).
- `color` (str): Color for the heatmap cells. Default is "#337ab7".

**Return**: 
- `plt.Axes` - Matplotlib axes object for the time series heatmap

#### Public Plotting Functions

**Function plot_word_cloud**

**Import Method**: `from ydata_profiling.visualisation.plot import plot_word_cloud`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Public interface for generating word cloud visualizations from text data.

**Signature**:
```python

@manage_matplotlib_context()
def plot_word_cloud(config: Settings, word_counts: pd.Series) -> str:
```
**Parameters**:
- `config` (Settings): Configuration settings for the word cloud plot
- `word_counts` (pd.Series): Series containing word frequencies for word cloud visualization

**Return**: 
- `str` - Rendered HTML string for the word cloud plot

**Function mini_histogram**

**Import Method**: `from ydata_profiling.visualisation.plot import mini_histogram`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Generates mini histogram visualization for compact display in reports.

**Signature**:
```python
@manage_matplotlib_context()
def mini_histogram(
    config: Settings,
    series: np.ndarray,
    bins: Union[int, np.ndarray],
    date: bool = False,
) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the mini histogram plot
- `series` (np.ndarray): Array of data values to be visualized
- `bins` (Union[int, np.ndarray]): Number of bins (int for equal size, ndarray for variable size)
- `date` (bool): Is histogram of date(time)? Default is False.

**Return**: 
- `str` - Rendered HTML string for the mini histogram plot

**Function correlation_matrix**

**Import Method**: `from ydata_profiling.visualisation.plot import correlation_matrix`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Generates correlation matrix heatmap using seaborn.

**Signature**:
```python
@manage_matplotlib_context()
def correlation_matrix(config: Settings, data: pd.DataFrame, vmin: int = -1) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the correlation matrix plot
- `data` (pd.DataFrame): Input DataFrame containing variables for correlation analysis
- `vmin` (int): Minimum value for color scale. Default is -1.

**Return**: 
- `str` - Rendered HTML string for the correlation matrix plot

**Function scatter_complex**

**Import Method**: `from ydata_profiling.visualisation.plot import scatter_complex`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Creates scatter plot for complex numbers showing real vs imaginary components.

**Signature**:
```python
@manage_matplotlib_context()
def scatter_complex(config: Settings, series: pd.Series) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the scatter complex plot
- `series` (pd.Series): Series containing complex numbers for scatter plot visualization

**Return**: 
- `str` - Rendered HTML string for the scatter complex plot

**Function scatter_series**

**Import Method**: `from ydata_profiling.visualisation.plot import scatter_series`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Creates scatter plot for series data containing coordinate pairs.

**Signature**:
```python
@manage_matplotlib_context()
def scatter_series(
    config: Settings, series: pd.Series, x_label: str = "Width", y_label: str = "Height"
) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the scatter series plot
- `series` (pd.Series): Series containing coordinate pairs for scatter plot visualization
- `x_label` (str): Label for x-axis. Default is "Width".
- `y_label` (str): Label for y-axis. Default is "Height".

**Return**: 
- `str` - Rendered HTML string for the scatter series plot

**Function scatter_pairwise**

**Import Method**: `from ydata_profiling.visualisation.plot import scatter_pairwise`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Creates pairwise scatter plots between two variables.

**Signature**:
```python
@manage_matplotlib_context()
def scatter_pairwise(
    config: Settings, series1: pd.Series, series2: pd.Series, x_label: str, y_label: str
) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the scatter pairwise plot
- `series1` (pd.Series): First series of data points for scatter plot
- `series2` (pd.Series): Second series of data points for scatter plot
- `x_label` (str): Label for x-axis.
- `y_label` (str): Label for y-axis.

**Return**: 
- `str` - Rendered HTML string for the scatter pairwise plot

**Function cat_frequency_plot**

**Import Method**: `from ydata_profiling.visualisation.plot import cat_frequency_plot`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Generates categorical frequency plot as bar chart or pie chart.

**Signature**:
```python
@manage_matplotlib_context()
def cat_frequency_plot(config: Settings, series: pd.Series) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the categorical frequency plot
- `series` (pd.Series): Series containing categorical data for frequency visualization

**Return**: 
- `str` - encoded category frequency plot encoded

**Function plot_missing_matrix**

**Import Method**: `from ydata_profiling.visualisation.plot import plot_missing_matrix`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Plots missing value matrix visualization showing missing data patterns.

**Signature**:
```python
@manage_matplotlib_context()
def plot_missing_matrix(
    config: Settings, notnull: Any, columns: List[str], nrows: int
) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the missing value matrix plot
- `notnull` (Any): Boolean mask indicating non-missing values in the DataFrame
- `columns` (List[str]): List of column names in the DataFrame
- `nrows` (int): Number of rows in the DataFrame

**Return**: 
- `str` - Rendered HTML string for the missing value matrix plot



**Function plot_missing_bar**

**Import Method**: `from ydata_profiling.visualisation.plot import plot_missing_bar`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Plots missing value bar chart showing percentage of missing values per variable.

**Signature**:
```python
@manage_matplotlib_context()
def plot_missing_bar(
    config: Settings, notnull_counts: list, nrows: int, columns: List[str]
) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the missing value bar plot
- `notnull_counts` (list): List of counts of non-missing values per column
- `nrows` (int): Number of rows in the DataFrame
- `columns` (List[str]): List of column names in the DataFrame

**Return**: 
- `str` - Rendered HTML string for the missing value bar plot


**Function plot_missing_heatmap**

**Import Method**: `from ydata_profiling.visualisation.plot import plot_missing_heatmap`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Plots missing value heatmap showing correlations between missing values.

**Signature**:
```python
@manage_matplotlib_context()
def plot_missing_heatmap(
    config: Settings, corr_mat: Any, mask: Any, columns: List[str]
) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the missing value heatmap plot
- `corr_mat` (Any): Correlation matrix computed from missing values
- `mask` (Any): Boolean mask indicating upper triangle of the correlation matrix
- `columns` (List[str]): List of column names in the DataFrame

**Return**: 
- `str` - Rendered HTML string for the missing value heatmap plot


**Function plot_timeseries_gap_analysis**

**Import Method**: `from ydata_profiling.visualisation.plot import plot_timeseries_gap_analysis`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Analyzes and plots gaps in timeseries data showing discontinuities.

**Signature**:
```python
@manage_matplotlib_context()
def plot_timeseries_gap_analysis(
    config: Settings,
    series: Union[pd.Series, List[pd.Series]],
    gaps: Union[pd.Series, List[pd.Series]],
    figsize: tuple = (6, 3),
) -> matplotlib.figure.Figure: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the timeseries gap analysis plot
- `series` (Union[pd.Series, List[pd.Series]]): Timeseries data or list of timeseries data for gap analysis
- `gaps` (Union[pd.Series, List[pd.Series]]): Gaps or list of gaps in timeseries data
- `figsize` (tuple, optional): Figure size for the plot. Defaults to (6, 3).

**Return**: 
- `matplotlib.figure.Figure` - Figure object for the timeseries gap analysis plot

**Function plot_overview_timeseries**

**Import Method**: `from ydata_profiling.visualisation.plot import plot_overview_timeseries`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Generates overview plot for timeseries showing trend and patterns.

**Signature**:
```python
@manage_matplotlib_context()
def plot_overview_timeseries(
    config: Settings,
    variables: Any,
    figsize: tuple = (6, 4),
    scale: bool = False,
) -> matplotlib.figure.Figure: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the timeseries overview plot
- `variables` (Any): Variables or list of variables for timeseries overview visualization
- `figsize` (tuple, optional): Figure size for the plot. Defaults to (6, 4).
- `scale` (bool, optional): Whether to scale the plot axes. Defaults to False.

**Return**: 
- `matplotlib.figure.Figure` - Figure object for the timeseries overview plot

**Function plot_acf_pacf**

**Import Method**: `from ydata_profiling.visualisation.plot import plot_acf_pacf`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Plots autocorrelation (ACF) and partial autocorrelation (PACF) functions for time series analysis.

**Signature**:
```python
@manage_matplotlib_context()
def plot_acf_pacf(
    config: Settings, series: Union[list, pd.Series], figsize: tuple = (15, 5)
) -> str: ...
```

**Function mini_ts_plot**

**Import Method**: `from ydata_profiling.visualisation.plot import mini_ts_plot`

**Decorator**: `@manage_matplotlib_context()`

**Function**: Generates mini timeseries plot for compact display.

**Signature**:
```python
@manage_matplotlib_context()
def mini_ts_plot(
    config: Settings,
    series: Union[list, pd.Series],
    figsize: Tuple[float, float] = (3, 2.25),
) -> str: ...
```

#### Utility Functions

**Function hex_to_rgb**

**Function**: Converts hexadecimal color code to RGB tuple.

**Signature**:
```python
from ydata_profiling.visualisation.plot import hex_to_rgb

def hex_to_rgb(value: str) -> Tuple[float, ...]: ...
```
**Parameters**:
- `value` (str): Hexadecimal color code (e.g., "#RRGGBB")

**Return**: 
- `Tuple[float, ...]` - RGB tuple with values normalized to [0, 1]

**Function base64_image**

**Function**: Converts matplotlib figure to base64 encoded string for HTML embedding.

**Signature**:
```python
from ydata_profiling.visualisation.plot import base64_image

def base64_image(image: bytes, mime_type: str) -> str: ...
```
**Parameters**:
- `image` (plt.Figure): Matplotlib figure object to be converted
- `image_format` (str, optional): Image format for encoding. Defaults to "png".

**Return**: 
- `str` - Base64 encoded string of the image

**Function plot_360_n0sc0pe**

**Import Method**: `from ydata_profiling.visualisation.utils import plot_360_n0sc0pe`

**Function**: Creates 360-degree visualization (specialized plot for specific data types).

**Signature**:
```python
def plot_360_n0sc0pe(
    config: Settings,
    image_format: Optional[str] = None,
    bbox_extra_artists: Optional[List[Artist]] = None,
    bbox_inches: Optional[str] = None,
) -> str: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for the 360-degree plot
- `image_format` (Optional[str], optional): Image format for encoding. Defaults to None.
- `bbox_extra_artists` (Optional[List[Artist]], optional): Extra artists for bounding box. Defaults to None.
- `bbox_inches` (Optional[str], optional): Bounding box inches for image cropping. Defaults to None.

**Return**: 
- `str` - Base64 encoded string of the 360-degree plot image

### Tool Module

#### Caching Tools

**Function cache_file**

**Function**: Implements file caching functionality for data files.

**Signature**:
```python
from ydata_profiling.utils.cache import cache_file

def cache_file(file_name: str, url: str) -> Path: ...
```
**Parameters**:
- `file_name` (str): Name of the file to be cached
- `url` (str): URL or path of the file to be cached

**Return**: 
- `Path` - Path to the cached file

#### DataFrame Tools

**Function hash_dataframe**

**Function**: Calculates the hash value of a DataFrame for caching and validation purposes.

**Signature**:
```python
from ydata_profiling.utils.dataframe import hash_dataframe

def hash_dataframe(df: pd.DataFrame) -> str: ...
```
**Parameters**:
- `df` (pd.DataFrame): DataFrame for which hash value is to be calculated

**Return**: 
- `str` - Hash value of the DataFrame

**Function expand_mixed**

**Function**: Expands mixed-type data into separate columns for better analysis.

**Signature**:
```python
from ydata_profiling.utils.dataframe import expand_mixed

def expand_mixed(df: pd.DataFrame, types: Any = None) -> pd.DataFrame: ...
```
**Parameters**:
- `df` (pd.DataFrame): DataFrame with mixed-type columns to be expanded
- `types` (Any, optional): Specific types to expand (e.g., str, int). Defaults to None.

**Return**: 
- `pd.DataFrame` - DataFrame with expanded columns for mixed-type data

**Function read_pandas**

**Function**: Reads data files supported by pandas (CSV, Excel, JSON, etc.).

**Signature**:
```python
from ydata_profiling.utils.dataframe import read_pandas

def read_pandas(file_name: Path) -> pd.DataFrame: ...
```

**Function uncompressed_extension**

**Function**: Gets the uncompressed file extension from a potentially compressed filename.

**Signature**:
```python
from ydata_profiling.utils.dataframe import uncompressed_extension

def uncompressed_extension(file_name: Path) -> str: ...
```
**Parameters**:
- `file_name` (Path): Path to the file for which uncompressed extension is to be determined

**Return**: 
- `str` - Uncompressed file extension (e.g., ".csv", ".xlsx")

**Function warn_read**

**Function**: Issues a warning when reading data encounters problems.

**Signature**:
```python
from ydata_profiling.utils.dataframe import warn_read

def warn_read(extension: str) -> None: ...
```
**Parameters**:
- `extension` (str): File extension (e.g., ".csv", ".xlsx")

**Return**: 
- `None` - Issues a warning message

**Function sort_column_names**

**Function**: Sorts column names alphabetically or by custom order.

**Signature**:
```python
from ydata_profiling.utils.dataframe import sort_column_names

def sort_column_names(dct: dict, sort: Optional[str] = None) -> dict: ...
```
**Parameters**:
- `dct` (dict): Dictionary with column names as keys
- `sort` (Optional[str], optional): Sort order ("asc" or "desc"). Defaults to None.

**Return**: 
- `dict` - Dictionary with sorted column names

**Function preprocess**

**Function**: Preprocesses DataFrame before analysis (handles duplicates, missing values, data types).

**Signature**:
```python
from ydata_profiling.utils.dataframe import preprocess

def preprocess(config: Settings, df: Any) -> Any: ...
```
**Parameters**:
- `config` (Settings): Configuration settings for preprocessing
- `df` (Any): Input data to be preprocessed (e.g., pd.DataFrame, Spark DataFrame)

**Return**: 
- `Any` - a pandas or spark dataframe

**Function redact_summary**

**Function**: Redacts sensitive information from summary data based on configuration.

**Signature**:
```python
from ydata_profiling.model.summarizer import redact_summary

def redact_summary(summary: dict, config: Settings) -> dict: ...
```

**Function redact_key**

**Function**: It is an internal function of the _redact_column function, Redacts dictionary keys based on configuration settings.

**Signature**:
```python
from ydata_profiling.utils.dataframe import redact_key

def redact_key(data: dict, config: Settings) -> dict: ...
```
**Parameters**:
- `data` (dict): Dictionary with keys to be redacted
- `config` (Settings): Configuration settings for redaction

**Return**: 
- `dict` - Dictionary with redacted keys

**Function redact_value**

**Function**: It is an internal function of the _redact_column function, Redacts dictionary values based on configuration settings.'

**Function redact_value**

**Function**: It is an internal function of the _redact_column functionRedacts dictionary values based on configuration settings.

**Signature**:
```python
from ydata_profiling.utils.dataframe import redact_value

def redact_value(data: dict, config: Settings) -> dict: ...
```
**Parameters**:
- `data` (dict): Dictionary with values to be redacted
- `config` (Settings): Configuration settings for redaction

**Return**: 
- `dict` - Dictionary with redacted values

**Function get_custom_sample**

**Function**: Gets custom sample data if configured in settings.

**Signature**:
```python
from ydata_profiling.utils.dataframe import get_custom_sample

def get_custom_sample(sample: dict) -> List[Sample]: ...
```

**Function get_scatter_tasks**

**Function**: Generates scatter plot tasks for variable interactions analysis.

**Signature**:
```python
from ydata_profiling.model.scatter import get_scatter_tasks

def get_scatter_tasks(
    config: Settings, continuous_variables: list
) -> List[Tuple[Any, Any]]: ...
```

**Function get_scatter_plot**

**Function**: Creates scatter plot visualization data for two variables.

**Signature**:
```python
from ydata_profiling.model.scatter import get_scatter_plot

def get_scatter_plot(
    config: Settings, df: pd.DataFrame, x: Any, y: Any, continuous_variables: list
) -> str: ...
```

**Utility Functions**

**Import Method**: `from ydata_profiling.utils.[module] import [function_name]`

**Function is_pyspark_installed**

**Import**: `from ydata_profiling.utils.backend import is_pyspark_installed`

**Signature**:
```python
def is_pyspark_installed() -> bool:
```

**Docstring**: "Check if PySpark is installed without importing it."

**Function cache_zipped_file**

**Import**: `from ydata_profiling.utils.cache import cache_zipped_file`

**Signature**:
```python
def cache_zipped_file(file_name: str, url: str) -> Path:
```

**Docstring**: "Check if file_name already is in the data path, otherwise download it from url."

**Parameters**:
- `file_name` (str): Name of the file to be cached
- `url` (str): URL to download the file from

**Return**: 
- `Path` - Path to the cached file

**Function convert_timestamp_to_datetime**

**Import**: `from ydata_profiling.utils.common import convert_timestamp_to_datetime`

**Signature**:
```python
def convert_timestamp_to_datetime(timestamp: int) -> datetime:
```

**Function**: Converts Unix timestamps to datetime objects.

**Function analytics_features**

**Import**: `from ydata_profiling.utils.common import analytics_features`

**Signature**:
```python
def analytics_features(dataframe: str, datatype: str, report_type: str, ncols: int, nrows: int, dbx: str) -> None:
```

**Function**: Sends analytics telemetry for usage tracking.

**Function is_running_in_databricks**

**Import**: `from ydata_profiling.utils.common import is_running_in_databricks`

**Signature**:
```python
def is_running_in_databricks():
```

**Function**: Checks if code is running in Databricks environment.

**Return**: 
- `bool` - True if running in Databricks, False otherwise

**Note**: This function lacks type annotations in the source code (src/ydata_profiling/utils/common.py:108).

**Function slugify**

**Import**: `from ydata_profiling.utils.dataframe import slugify`

**Signature**:
```python
def slugify(value: str, allow_unicode: bool = False) -> str:
```

**Docstring**: "Taken from https://github.com/django/django/blob/master/django/utils/text.py Convert to ASCII if 'allow_unicode' is False. Convert spaces or repeated dashes to single dashes. Remove characters that aren't alphanumerics, underscores, or hyphens. Convert to lowercase. Also strip leading and trailing whitespace, dashes, and underscores."

**Parameters**:
- `value` (str): String to be slugified
- `allow_unicode` (bool, optional): Whether to allow Unicode characters in the slug. Defaults to False.

**Return**: 
- `str` - Slugified string

**Function in_jupyter_notebook**

**Import**: `from ydata_profiling.utils.information import in_jupyter_notebook`

**Signature**:
```python
def in_jupyter_notebook() -> bool:
```

**Docstring**: "Check if the code is running inside a Jupyter Notebook"

**Return**: 
- `bool` - True if running in Jupyter Notebook, False otherwise

**Function get_project_root**

**Import**: `from ydata_profiling.utils.paths import get_project_root`

**Signature**:
```python
def get_project_root() -> Path:
```

**Return**: 
- `Path` - Path to the project root folder

**Docstring**: "Returns the path to the project root folder."

**Function get_data_path**

**Import**: `from ydata_profiling.utils.paths import get_data_path`

**Signature**:
```python
def get_data_path() -> Path:
```

**Docstring**: "Returns the path to the dataset cache ([root] / data)"

**Function get_html_template_path**

**Import**: `from ydata_profiling.utils.paths import get_html_template_path`

**Signature**:
```python
def get_html_template_path() -> Path:
```

**Docstring**: "Returns the path to the HTML templates"

**Return**: 
- `Path` - Path to the HTML templates folder

**Function calculate_nrows**

**Function**: Calculates the approximate number of rows in Spark DataFrames or exact count for pandas DataFrames. For Spark, estimates based on the first partition multiplied by total partitions.

**Signature**:
```python
from ydata_profiling.utils.common import calculate_nrows

def calculate_nrows(df): ...
```

**Parameters**:
- df: Union[pd.DataFrame, pyspark.sql.DataFrame] - DataFrame to count rows for

**Returns**: int - Number of rows (exact for pandas, approximate for Spark)

---

**Function is_supported_compression**

**Function**: Determines if the given file extension indicates a compression format that pandas can handle automatically (bz2, gz, xz, zip).

**Signature**:
```python
from ydata_profiling.utils.dataframe import is_supported_compression

def is_supported_compression(file_extension: str) -> bool: ...
```

**Parameters**:
- file_extension: str - The file extension to test (e.g., '.gz', '.zip')

**Returns**: bool - True if pandas can decompress automatically, False otherwise

---

**Function pandas_major_version**

**Function**: Returns the major version number of the installed pandas library.

**Signature**:
```python
from ydata_profiling.utils.versions import pandas_major_version

def pandas_major_version() -> int: ...
```

**Returns**: int - Major version number (e.g., 1 or 2)

---

**Function is_pandas_1**

**Function**: Checks if pandas version 1.x is currently installed.

**Signature**:
```python
from ydata_profiling.utils.versions import is_pandas_1

def is_pandas_1() -> bool: ...
```

**Returns**: bool - True if pandas major version is 1, False otherwise

---

**Function get_font_size**

**Function**: Calculates appropriate font size for missing values visualizations based on the number of columns and maximum label length.

**Signature**:
```python
from ydata_profiling.visualisation.missing import get_font_size

def get_font_size(columns: List[str]) -> float: ...
```

**Parameters**:
- columns: List[str] - List of column names

**Returns**: float - Calculated font size for plots

---

**Function get_alert_styles**

**Function**: Returns a dictionary mapping alert types to Bootstrap CSS style classes for rendering alerts in the HTML report.

**Signature**:
```python
from ydata_profiling.utils.styles import get_alert_styles

def get_alert_styles() -> dict: ...
```

**Returns**: dict - Mapping of alert type names to CSS classes (e.g., 'constant': 'warning')

---

**Report Structure Functions**

**Function get_report_structure**

**Function**: Main entry point to generate the complete report structure. Assembles all report sections (overview, variables, interactions, correlations, missing values, samples, duplicates) into a Root object.

**Signature**:
```python
from ydata_profiling.report.structure.report import get_report_structure

def get_report_structure(config: Settings, summary: BaseDescription) -> Root: ...
```

**Parameters**:
- config: Settings - Report Settings object
- summary: BaseDescription - Statistics for overview, variables, correlations and missing values

**Returns**: Root - Complete report structure in HTML format

**Docstring**: "Generate a HTML report from summary statistics and a given sample."

---

**Function get_dataset_overview**

**Function**: Generates the dataset overview section with statistics table (number of variables, observations, missing cells, duplicates, memory size) and variable types table.

**Signature**:
```python
from ydata_profiling.report.structure.overview import get_dataset_overview

def get_dataset_overview(config: Settings, summary: BaseDescription) -> Renderable: ...
```

**Parameters**:
- config: Settings - Report Settings object
- summary: BaseDescription - Dataset summary statistics

**Returns**: Renderable - Container with dataset statistics and variable types tables

---

**Function get_dataset_schema**

**Function**: Generates dataset schema information section from metadata (description, creator, author, URL, copyright).

**Signature**:
```python
from ydata_profiling.report.structure.overview import get_dataset_schema

def get_dataset_schema(config: Settings, metadata: dict) -> Container: ...
```

**Parameters**:
- config: Settings - Report Settings object
- metadata: dict - Metadata dictionary with dataset information

**Returns**: Container - Container with dataset metadata table

---

**Function get_dataset_reproduction**

**Function**: Generates the reproduction information section showing analysis timing, duration, software version and downloadable configuration.

**Signature**:
```python
from ydata_profiling.report.structure.overview import get_dataset_reproduction

def get_dataset_reproduction(config: Settings, summary: BaseDescription) -> Renderable: ...
    @list_args
    def fmt_version(version: str) -> str: ...
    @list_args
    def fmt_config(config: str) -> str: ...
```

**Parameters**:
- config: Settings - Settings object
- summary: BaseDescription - Dataset summary with analysis timing information

**Returns**: Renderable - Container with reproduction information table

**Method**
- fmt_version: Formats version string with major and minor version numbers.
- fmt_config: Formats configuration dictionary as a string for display.

**Docstring**: "Dataset reproduction part of the report"

---

**Function get_dataset_column_definitions**

**Function**: Generates the column definitions section showing user-provided descriptions for each variable.

**Signature**:
```python
from ydata_profiling.report.structure.overview import get_dataset_column_definitions

def get_dataset_column_definitions(config: Settings, definitions: dict) -> Container: ...
```

**Parameters**:
- config: Settings - Settings object
- definitions: dict - Variable descriptions dictionary

**Returns**: Container - Container with variable descriptions table

**Docstring**: "Generate an overview section for the variable description"

---

**Function get_dataset_alerts**

**Function**: Generates the dataset alerts section with all data quality alerts, handling both single and multiple report comparisons.

**Signature**:
```python
from ydata_profiling.report.structure.overview import get_dataset_alerts

def get_dataset_alerts(config: Settings, alerts: list) -> Alerts: ...
```

**Parameters**:
- config: Settings - Settings object
- alerts: list - List of Alert objects (or tuple of lists for comparisons)

**Returns**: Alerts - Alerts renderable object with count

**Docstring**: "Obtain the alerts for the report"

---

**Function get_timeseries_items**

**Function**: Generates timeseries overview section with statistics (number of series, length, period) and visualizations (original and scaled plots).

**Signature**:
```python
from ydata_profiling.report.structure.overview import get_timeseries_items

def get_timeseries_items(config: Settings, summary: BaseDescription) -> Container: ...
    @list_args
    def fmt_tsindex_limit(limit: Any) -> str: ...

```

**Parameters**:
- config: Settings - Settings object
- summary: BaseDescription - Dataset summary with time_index_analysis

**Method**
- fmt_tsindex_limit: Formats the limit value for timeseries index analysis.

**Returns**: Container - Container with timeseries statistics and plots

---

**Function get_dataset_items**

**Function**: Assembles the complete dataset overview section at the top of the report, including overview, metadata, column definitions, timeseries, alerts and reproduction info.

**Signature**:
```python
from ydata_profiling.report.structure.overview import get_dataset_items

def get_dataset_items(config: Settings, summary: BaseDescription, alerts: list) -> list: ...
```

**Parameters**:
- config: Settings - Settings object
- summary: BaseDescription - Calculated dataset summary
- alerts: list - List of alerts

**Returns**: list - List of Renderable components for dataset overview

**Docstring**: "Returns the dataset overview (at the top of the report)"

---

**Function get_missing_items**

**Function**: Creates missing value visualization items (matrices and diagrams) from summary statistics, supporting both single and comparative reports.

**Signature**:
```python
from ydata_profiling.report.structure.report import get_missing_items

def get_missing_items(config: Settings, summary: BaseDescription) -> list: ...
```

**Parameters**:
- config: Settings - Report Settings object
- summary: BaseDescription - Dataframe summary with missing value data

**Returns**: list - List of ImageWidget or Container items with missing diagrams

**Docstring**: "Return the missing diagrams"

---

**Function get_duplicates_items**

**Function**: Creates the list of duplicate rows items for display, handling both single DataFrames and lists of DataFrames for comparison.

**Signature**:
```python
from ydata_profiling.report.structure.report import get_duplicates_items

def get_duplicates_items(config: Settings, duplicates: pd.DataFrame) -> List[Renderable]: ...
```

**Parameters**:
- config: Settings - Settings object
- duplicates: pd.DataFrame - DataFrame of duplicate rows (or list of DataFrames)

**Returns**: List[Renderable] - List of Duplicate items to show in interface

**Docstring**: "Create the list of duplicates items"

---

**Function get_definition_items**

**Function**: Creates column definition items from the definitions DataFrame for display in the report.

**Signature**:
```python
from ydata_profiling.report.structure.report import get_definition_items

def get_definition_items(definitions: pd.DataFrame) -> Sequence[Renderable]: ...
```

**Parameters**:
- definitions: pd.DataFrame - DataFrame of column definitions

**Returns**: Sequence[Renderable] - List of column definitions to show in interface

**Docstring**: "Create the list of duplicates items"

---

**Function get_sample_items**

**Function**: Creates sample data items for display, supporting multiple samples (head, tail, random) and comparative reports.

**Signature**:
```python
from ydata_profiling.report.structure.report import get_sample_items

def get_sample_items(config: Settings, sample: dict) -> List[Renderable]: ...
```

**Parameters**:
- config: Settings - Settings object
- sample: dict - Dict of sample objects (or tuple for comparisons)

**Returns**: List[Renderable] - List of Sample items to show in interface

**Docstring**: "Create the list of sample items"

---

**Function get_interactions**

**Function**: Generates variable interaction (scatter plot) components for the report, organizing plots by variable pairs with tab or dropdown navigation.

**Signature**:
```python
from ydata_profiling.report.structure.report import get_interactions

def get_interactions(config: Settings, interactions: dict) -> list: ...
```

**Parameters**:
- config: Settings - Report Settings object
- interactions: dict - Nested dict containing scatter plots keyed by variable pairs

**Returns**: list - List of Container components for interaction section

**Docstring**: "Returns the interaction components for the report"

---

**Function render_variables_section**

**Function**: Renders the HTML for each variable in the DataFrame. Creates Variable objects with statistics, alerts, and type-specific visualizations using the appropriate render function.

**Signature**:
```python
from ydata_profiling.report.structure.report import render_variables_section

def render_variables_section(
    config: Settings, dataframe_summary: BaseDescription
) -> list: ...
```

**Parameters**:
- config: Settings - Report Settings object
- dataframe_summary: BaseDescription - Statistics for each variable

**Returns**: list - List of Variable renderable objects

**Docstring**: "Render the HTML for each of the variables in the DataFrame."

**Report Structure - Variable Rendering Functions**

**Import Method**: `from ydata_profiling.report.structure.variables import [function_name]`

**Function render_categorical**

**Signature**:
```python
def render_categorical(config: Settings, summary: dict) -> dict
```

**Function**: Renders the complete report structure for categorical variables. Creates all visualization components including frequency tables, length analysis, character/word analysis, and optional category plots.

**Parameters**:
- `config`: Settings object containing configuration for categorical variables
- `summary`: Dictionary containing categorical variable statistics (value_counts, length stats, character counts, etc.)

**Returns**: Dictionary containing template variables with all renderable components (info, table, frequency tables, plots, etc.)

**Function render_boolean**

**Signature**:
```python
def render_boolean(config: Settings, summary: dict) -> dict
```

**Function**: Renders the complete report structure for boolean variables. Creates frequency tables, value distribution plots, and statistics tables specific to boolean data.

**Parameters**:
- `config`: Settings object containing configuration for boolean variables
- `summary`: Dictionary containing boolean variable statistics

**Returns**: Dictionary containing template variables with all renderable components

**Function render_real**

**Signature**:
```python
def render_real(config: Settings, summary: dict) -> dict
```

**Function**: Renders the complete report structure for real number (numeric) variables. Creates histograms, statistics tables, quantile information, and extreme values tables.

**Parameters**:
- `config`: Settings object containing configuration for numeric variables
- `summary`: Dictionary containing numeric variable statistics (mean, std, min, max, quantiles, histogram data, etc.)

**Returns**: Dictionary containing template variables with all renderable components including histograms and statistics

**Function render_date**

**Signature**:
```python
def render_date(config: Settings, summary: Dict[str, Any]) -> Dict[str, Any]
```

**Function**: Renders the complete report structure for date/datetime variables. Creates date range information, histogram of date distribution, and date-specific statistics.

**Parameters**:
- `config`: Settings object containing configuration
- `summary`: Dictionary containing date variable statistics (min, max, range, histogram, etc.)

**Returns**: Dictionary containing template variables with date-specific renderable components

**Function render_text**

**Signature**:
```python
def render_text(config: Settings, summary: Dict[str, Any]) -> Dict[str, Any]: ...
```

**Function**: Renders the complete report structure for text variables. Creates length analysis, character/word statistics, sample values, and optional word clouds.

**Parameters**:
- `config`: Settings object containing configuration for text variables
- `summary`: Dictionary containing text statistics (length, words, characters, samples, etc.)

**Returns**: Dictionary containing template variables with text analysis components

**Function render_timeseries**

**Signature**:
```python
def render_timeseries(config: Settings, summary: dict) -> dict
```

**Function**: Renders the complete report structure for timeseries variables. Extends numeric rendering with additional time-series specific analysis (ACF/PACF plots, stationarity tests, seasonality, trend analysis).

**Parameters**:
- `config`: Settings object containing configuration for timeseries variables
- `summary`: Dictionary containing timeseries statistics (numeric stats + ACF, PACF, stationarity, seasonality data)

**Returns**: Dictionary containing template variables with timeseries-specific components

**Function render_common**

**Import Method**: `from ydata_profiling.report.structure.variables.render_common import render_common`

**Signature**:
```python
def render_common(config: Settings, summary: dict) -> dict
```

**Function**: Renders common statistics shared across all variable types. Creates the base statistics table with count, missing values, distinct values, and memory usage.

**Returns**: Dictionary with common template variables (common table, alerts, etc.)

---

**Helper Rendering Functions**

**Function render_categorical_frequency**

**Function**: Renders the frequency statistics table for categorical variables, including unique value count and percentage.

**Signature**:
```python
from ydata_profiling.report.structure.variables.render_categorical import render_categorical_frequency

def render_categorical_frequency(
    config: Settings, summary: dict, varid: str
) -> Renderable: ...
```

**Parameters**:
- config: Settings - Report Settings object
- summary: dict - Variable summary dictionary containing n_unique, p_unique statistics
- varid: str - Variable ID for anchor generation

**Returns**: Renderable - Table with unique value statistics

---

**Function render_categorical_length**

**Function**: Renders the length analysis for categorical variables, including length statistics table (max, median, mean, min) and length distribution histogram.

**Signature**:
```python
from ydata_profiling.report.structure.variables.render_categorical import render_categorical_length

def render_categorical_length(
    config: Settings, summary: dict, varid: str
) -> Tuple[Renderable, Renderable]: ...
```

**Parameters**:
- config: Settings - Report Settings object
- summary: dict - Variable summary containing length statistics (max_length, median_length, mean_length, min_length, histogram_length)
- varid: str - Variable ID for anchor generation

**Returns**: Tuple[Renderable, Renderable] - Length statistics table and length histogram

---

**Function render_categorical_unicode**

**Function**: Renders comprehensive Unicode character analysis for categorical variables, including character counts, category analysis, script analysis, and block analysis with frequency tables.

**Signature**:
```python
from ydata_profiling.report.structure.variables.render_categorical import render_categorical_unicode

def render_categorical_unicode(
    config: Settings, summary: dict, varid: str
) -> Tuple[Renderable, Renderable]: ...
```

**Parameters**:
- config: Settings - Report Settings object
- summary: dict - Variable summary with Unicode analysis data (character_counts, category_alias_counts, script_counts, block_alias_counts, etc.)
- varid: str - Variable ID for anchor generation

**Returns**: Tuple[Renderable, Renderable] - Overview statistics table and tabbed Unicode analysis container

---

**Pandas-Specific Functions**

**Function pandas_preprocess**

**Function**: Preprocesses the pandas DataFrame before analysis: renames the "index" column to "df_index" if it exists, and converts all column names to strings.

**Signature**:
```python
from ydata_profiling.model.pandas import pandas_preprocess

def pandas_preprocess(config: Settings, df: pd.DataFrame) -> pd.DataFrame: ...
```

**Parameters**:
- config: Settings - Report Settings object
- df: pd.DataFrame - The pandas DataFrame to preprocess

**Returns**: pd.DataFrame - The preprocessed DataFrame

**Docstring**:
```
Preprocess the dataframe

- Appends the index to the dataframe when it contains information
- Rename the "index" column to "df_index", if exists
- Convert the DataFrame's columns to str
```

---

**Function pandas_describe_1d**

**Function**: Describes a pandas Series by inferring or detecting the variable type, then calculating type-specific statistical values using the appropriate summarizer.

**Signature**:
```python
from ydata_profiling.model.pandas import pandas_describe_1d

def pandas_describe_1d(
    config: Settings,
    series: pd.Series,
    summarizer: BaseSummarizer,
    typeset: VisionsTypeset,
) -> dict: ...
```

**Parameters**:
- config: Settings - Report Settings object
- series: pd.Series - The Series to describe
- summarizer: BaseSummarizer - Summarizer object for computing statistics
- typeset: VisionsTypeset - Typeset for type inference/detection

**Returns**: dict - Dictionary containing calculated series description values

**Docstring**: "Describe a series (infer the variable type, then calculate type-specific values)."

---

- **Function pandas_describe_boolean_1d**: Describes boolean variable in pandas.

**Decorators**:
- `@describe_boolean_1d.register` - Registers this function as a multimethod implementation for boolean data
- `@series_hashable` - Ensures the series values are hashable before processing

**Signature**:

```python
@describe_boolean_1d.register
@series_hashable
def pandas_describe_boolean_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]:
```

**Docstring**:
```
Describe a boolean series.

Args:
    config: report Settings object
    series: The Series to describe.
    summary: The dict containing the series description so far.

Returns:
    A dict containing calculated series description values.
```

- **Function pandas_describe_categorical_1d**: Describes categorical variable in pandas.

**Decorators**:
- `@describe_categorical_1d.register` - Registers this function as a multimethod implementation for categorical data
- `@series_hashable` - Ensures the series values are hashable before processing
- `@series_handle_nulls` - Handles null values appropriately before analysis

**Detailed Signature**:

```python
@describe_categorical_1d.register
@series_hashable
@series_handle_nulls
def pandas_describe_categorical_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]:
```

**Docstring**:
```
Describe a categorical series.

Args:
    config: report Settings object
    series: The Series to describe.
    summary: The dict containing the series description so far.

Returns:
    A dict containing calculated series description values.
```

**Algorithm**:
```
1. Convert series to string type (handle Issue #100)
2. Get value_counts_without_nan and convert index to string
3. Calculate imbalance score:
   - Use column_imbalance_score(value_counts, len(value_counts))
4. If not redacted: add first 5 rows to summary
5. If chi_squared_threshold > 0:
   - Compute chi-square test on value counts histogram
6. If config.vars.cat.length is True:
   - Calculate length summary (max, mean, median, min length)
   - Create length histogram
7. If config.vars.cat.characters is True:
   - Perform unicode character analysis:
     - Get character counts
     - Calculate unicode blocks (Basic Latin, etc.)
     - Calculate scripts (Latin, Cyrillic, etc.)
     - Calculate character categories (Letter, Number, etc.)
     - Count n_characters_distinct, n_characters
8. If config.vars.cat.words is True:
   - Perform word analysis:
     - Split strings into words
     - Count word frequencies
     - Filter out stop_words
9. If config.vars.cat.dirty_categories is True:
   - Display info banner for ydata-sdk dirty categories feature
10. Return (config, series, summary)
```

---

**Function pandas_describe_counts**

**Decorators**:
- `@describe_counts.register` - Registers this function as a multimethod implementation for count statistics

**Function**: Counts the values in a pandas Series, calculating counts with and without NaN values, distinct values, and checking if values are hashable and orderable.

**Signature**:
```python
from ydata_profiling.model.pandas import pandas_describe_counts

@describe_counts.register
def pandas_describe_counts(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]: ...
```

**Parameters**:
- config: Settings - Report Settings object
- series: pd.Series - Series for which we want to calculate the values
- summary: dict - Series' summary dictionary

**Returns**: Tuple[Settings, pd.Series, dict] - Updated config, series, and summary dictionary with count values

**Docstring**: "Counts the values in a series (with and without NaN, distinct)."

---

**Function pandas_describe_date_1d**

**Decorators**:
- `@describe_date_1d.register` - Registers this function as a multimethod implementation for date/datetime data
- `@series_hashable` - Ensures the series values are hashable before processing
- `@series_handle_nulls` - Handles null values appropriately before analysis

**Signature**:

```python
@describe_date_1d.register
@series_hashable
@series_handle_nulls
def pandas_describe_date_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]:
```

**Docstring**:
```
Describe a date series.

Args:
    config: report Settings object
    series: The Series to describe.
    summary: The dict containing the series description so far.

Returns:
    A dict containing calculated series description values.
```

**Function pandas_describe_file_1d**

**Function**: Describes file-type variable in pandas, extracting file statistics including size, creation time, access time, and modification time.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_file_pandas import pandas_describe_file_1d

@describe_file_1d.register
def pandas_describe_file_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]: ...
```

**Decorators**:
- `@describe_file_1d.register` - Registers this function as a multimethod implementation for file data

**Parameters**:
- config: Settings - report Settings object
- series: pd.Series - The Series containing file paths to describe
- summary: dict - The dict containing the series description so far

**Returns**: Tuple[Settings, pd.Series, dict] - A tuple containing config, series, and updated summary dict

**Raises**:
- ValueError: If series contains NaNs or doesn't have .str accessor

---

**Function pandas_describe_generic**

**Function**: Describes generic series, calculating basic statistics including count, missing values, and memory usage.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_generic_pandas import pandas_describe_generic

@describe_generic.register
def pandas_describe_generic(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]: ...
```

**Decorators**:
- `@describe_generic.register` - Registers this function as a multimethod implementation for generic data

**Parameters**:
- config: Settings - report Settings object
- series: pd.Series - The Series to describe
- summary: dict - The dict containing the series description so far

**Returns**: Tuple[Settings, pd.Series, dict] - A tuple containing config, series, and updated summary dict with calculated values

**Docstring**: "Describe generic series."

---

**Function pandas_describe_image_1d**

**Function**: Describes image variable in pandas, extracting image information including dimensions, EXIF data, and optional hash for duplicate detection.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import pandas_describe_image_1d

@describe_image_1d.register
def pandas_describe_image_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]: ...
```

**Decorators**:
- `@describe_image_1d.register` - Registers this function as a multimethod implementation for image data

**Parameters**:
- config: Settings - report Settings object
- series: pd.Series - The Series containing image paths to describe
- summary: dict - The dict containing the series description so far

**Returns**: Tuple[Settings, pd.Series, dict] - A tuple containing config, series, and updated summary dict

**Raises**:
- ValueError: If series contains NaNs or doesn't have .str accessor

---
- **Function pandas_describe_numeric_1d**: Describes numeric variable in pandas.

**Decorators**:
- `@describe_numeric_1d.register` - Registers this function as a multimethod implementation for numeric data
- `@series_hashable` - Ensures the series values are hashable before processing
- `@series_handle_nulls` - Handles null values appropriately before analysis

**Detailed Signature**:

```python
@describe_numeric_1d.register
@series_hashable
@series_handle_nulls
def pandas_describe_numeric_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]:
```

**Docstring**:
```
Describe a numeric series.

Args:
    config: report Settings object
    series: The Series to describe.
    summary: The dict containing the series description so far.

Returns:
    A dict containing calculated series description values.
```

**Algorithm**:
```
1. Extract configuration thresholds (chi_squared_threshold, quantiles)
2. Get value_counts_without_nan from summary
3. Calculate negative values:
   - Count values where index < 0
   - Compute n_negative and p_negative
4. Calculate infinite values:
   - Find values that are np.inf or -np.inf
   - Compute n_infinite
5. Calculate zero values:
   - Check if 0 exists in value_counts
   - Compute n_zeros
6. Compute statistics based on dtype:
   - If IntegerDtype: use numeric_stats_pandas()
   - Otherwise: use numeric_stats_numpy() on finite values
   Statistics include: mean, std, variance, min, max, kurtosis, skewness, sum
7. Calculate MAD (Median Absolute Deviation)
8. If chi_squared_threshold > 0: compute chi-square statistic
9. Calculate derived metrics:
   - range = max - min
   - quantiles (5%, 25%, 50%, 75%, 95% or custom)
   - iqr = 75% - 25%
   - cv = std / mean (coefficient of variation)
   - p_zeros, p_infinite
10. Check monotonicity:
    - monotonic_increase, monotonic_decrease
    - monotonic_increase_strict, monotonic_decrease_strict
    - Assign monotonic code: 2/-2 (strict), 1/-1 (non-strict), 0 (none)
11. If non-infinity values exist: compute histogram
12. Return (config, series, stats)
```

---

**Function pandas_describe_path_1d**

**Function**: Describes path-type variable in pandas, extracting path components including common prefix, stem, suffix, name, parent directory, and anchor.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_path_pandas import pandas_describe_path_1d

@describe_path_1d.register
def pandas_describe_path_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]: ...
```

**Decorators**:
- `@describe_path_1d.register` - Registers this function as a multimethod implementation for path data

**Parameters**:
- config: Settings - report Settings object
- series: pd.Series - The Series containing paths to describe
- summary: dict - The dict containing the series description so far

**Returns**: Tuple[Settings, pd.Series, dict] - A tuple containing config, series, and updated summary dict with calculated values

**Raises**:
- ValueError: If series contains NaNs or doesn't have .str accessor

**Docstring**: "Describe a path series."

---

- **Function pandas_describe_supported**: Checks if pandas variable type is supported and calculates distinct/unique statistics.

**Decorators**:
- `@describe_supported.register` - Registers this function as a multimethod implementation for supported data types
- `@series_hashable` - Ensures the series values are hashable before processing

**Signature**:

```python
@describe_supported.register
@series_hashable
def pandas_describe_supported(
    config: Settings, series: pd.Series, series_description: dict
) -> Tuple[Settings, pd.Series, dict]:
```

**Docstring**:
```
Describe a supported series.

Args:
    config: report Settings object
    series: The Series to describe.
    series_description: The dict containing the series description so far.

Returns:
    A dict containing calculated series description values.
```

**Algorithm**:
```
1. Extract count from series_description
2. Get value_counts_without_nan
3. Calculate distinct_count = len(value_counts)
4. Calculate unique_count = count of values that appear exactly once
5. Compute statistics:
   - n_distinct: number of distinct values
   - p_distinct: proportion of distinct values (distinct_count / count)
   - is_unique: True if all values are unique (unique_count == count > 0)
   - n_unique: number of unique values (appearing once)
   - p_unique: proportion of unique values (unique_count / count)
6. Update and return stats dictionary
```

- **Function pandas_describe_text_1d**: Describes text variable in pandas.

**Decorators**:
- `@series_hashable` - Ensures the series values are hashable before processing
- `@series_handle_nulls` - Handles null values appropriately before analysis

**Signature**:

```python
@series_hashable
@series_handle_nulls
def pandas_describe_text_1d(
    config: Settings,
    series: pd.Series,
    summary: dict,
) -> Tuple[Settings, pd.Series, dict]:
```

**Docstring**:
```
Describe string series.

Args:
    config: report Settings object
    series: The Series to describe.
    summary: The dict containing the series description so far.

Returns:
    A dict containing calculated series description values.
```

**Important Note**: Unlike other `describe_*_1d` functions, `pandas_describe_text_1d` does **NOT** use the `@describe_text_1d.register` decorator. This is an intentional design choice in the source code. The function only has `@series_hashable` and `@series_handle_nulls` decorators. Text type processing is integrated into the multimethod system through alternative registration mechanisms.

- **Function pandas_describe_timeseries_1d**: Describes timeseries variable in pandas.

**Decorators**:
- `@describe_timeseries_1d.register` - Registers this function as a multimethod implementation for timeseries data
- `@series_hashable` - Ensures the series values are hashable before processing
- `@series_handle_nulls` - Handles null values appropriately before analysis

**Signature**:

```python
@describe_timeseries_1d.register
@series_hashable
@series_handle_nulls
def pandas_describe_timeseries_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]:
```

**Docstring**:
```
Describe a timeseries.

Args:
    config: report Settings object
    series: The Series to describe.
    summary: The dict containing the series description so far.

Returns:
    A dict containing calculated series description values.
```

**Function pandas_describe_url_1d**

**Function**: Describes URL variable in pandas, parsing URLs into components (scheme, netloc, path, query, fragment) and generating value counts for each component.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_url_pandas import pandas_describe_url_1d

@describe_url_1d.register
def pandas_describe_url_1d(
    config: Settings, series: pd.Series, summary: dict
) -> Tuple[Settings, pd.Series, dict]: ...
```

**Decorators**:
- `@describe_url_1d.register` - Registers this function as a multimethod implementation for URL data

**Parameters**:
- config: Settings - report Settings object
- series: pd.Series - The Series containing URLs to describe
- summary: dict - The dict containing the series description so far

**Returns**: Tuple[Settings, pd.Series, dict] - A tuple containing config, series (transformed to parsed URLs), and updated summary dict

**Raises**:
- ValueError: If series contains NaNs or doesn't have .str accessor

**Docstring**: "Describe a url series."

---

**Function pandas_get_duplicates**

**Function**: Obtains the most occurring duplicate rows in the DataFrame.

**Signature**:
```python
from ydata_profiling.model.pandas.duplicates_pandas import pandas_get_duplicates

@get_duplicates.register(Settings, pd.DataFrame, Sequence)
def pandas_get_duplicates(
    config: Settings, df: pd.DataFrame, supported_columns: Sequence
) -> Tuple[Dict[str, Any], Optional[pd.DataFrame]]: ...
```

**Decorators**:
- `@get_duplicates.register(Settings, pd.DataFrame, Sequence)` - Registers this function as a multimethod implementation for pandas DataFrames

**Parameters**:
- config: Settings - report Settings object
- df: pd.DataFrame - the Pandas DataFrame
- supported_columns: Sequence - the columns to consider

**Returns**: Tuple[Dict[str, Any], Optional[pd.DataFrame]] - A tuple containing metrics dict and a subset of the DataFrame ordered by occurrence

**Docstring**: "Obtain the most occurring duplicate rows in the DataFrame."

---

**Function pandas_get_sample**

**Function**: Obtains a sample from head and tail of the DataFrame.

**Signature**:
```python
from ydata_profiling.model.pandas.sample_pandas import pandas_get_sample

@get_sample.register(Settings, pd.DataFrame)
def pandas_get_sample(config: Settings, df: pd.DataFrame) -> List[Sample]: ...
```

**Decorators**:
- `@get_sample.register(Settings, pd.DataFrame)` - Registers this function as a multimethod implementation for pandas DataFrames

**Parameters**:
- config: Settings - Settings object
- df: pd.DataFrame - the pandas DataFrame

**Returns**: List[Sample] - a list of Sample objects

**Docstring**: "Obtains a sample from head and tail of the DataFrame"

---

**Function pandas_get_series_descriptions**

**Function**: Gets series descriptions for all columns in a DataFrame using parallel processing.

**Signature**:
```python
from ydata_profiling.model.pandas.summary_pandas import pandas_get_series_descriptions

def pandas_get_series_descriptions(
    config: Settings,
    df: pd.DataFrame,
    summarizer: BaseSummarizer,
    typeset: VisionsTypeset,
    pbar: tqdm,
) -> dict: ...
```

**Parameters**:
- config: Settings - report Settings object
- df: pd.DataFrame - the DataFrame to describe
- summarizer: BaseSummarizer - Summarizer object
- typeset: VisionsTypeset - Typeset for type inference
- pbar: tqdm - progress bar object

**Returns**: dict - dictionary of series descriptions sorted by column names

---

**Function pandas_get_table_stats**

**Function**: General statistics for the DataFrame including memory usage, missing values, and variable type counts.

**Signature**:
```python
from ydata_profiling.model.pandas.table_pandas import pandas_get_table_stats

@get_table_stats.register
def pandas_get_table_stats(
    config: Settings, df: pd.DataFrame, variable_stats: dict
) -> dict: ...
```

**Decorators**:
- `@get_table_stats.register` - Registers this function as a multimethod implementation for table statistics

**Parameters**:
- config: Settings - report Settings object
- df: pd.DataFrame - The DataFrame to describe
- variable_stats: dict - Previously calculated statistic on the DataFrame

**Returns**: dict - A dictionary that contains the table statistics

**Docstring**: "General statistics for the DataFrame."

---

**Function pandas_get_time_index_description**

**Function**: Gets time index description for pandas DataFrame with numeric or datetime index.

**Signature**:
```python
from ydata_profiling.model.pandas.timeseries_index_pandas import pandas_get_time_index_description

@get_time_index_description.register
def pandas_get_time_index_description(
    config: Settings,
    df: pd.DataFrame,
    table_stats: dict,
) -> dict: ...
```

**Decorators**:
- `@get_time_index_description.register` - Registers this function as a multimethod implementation for time index description

**Parameters**:
- config: Settings - report Settings object
- df: pd.DataFrame - The DataFrame with time index
- table_stats: dict - Previously calculated table statistics

**Returns**: dict - Dictionary containing time index statistics (n_series, length, start, end, period)

---

**Spark-Specific Functions**

**Import Method**: `from ydata_profiling.model.spark import [function_name]`

---

**Function spark_preprocess**

**Function**: Preprocesses the Spark DataFrame by removing MapType columns, which are not supported by the profiling system.

**Signature**:
```python
from ydata_profiling.model.spark.dataframe_spark import spark_preprocess

def spark_preprocess(config: Settings, df: DataFrame) -> DataFrame: ...
```

**Parameters**:
- config: Settings - Report settings object
- df: DataFrame - The Spark DataFrame

**Returns**: DataFrame - The preprocessed DataFrame without MapType columns

**Docstring**: "Preprocess the Spark DataFrame by removing MapType columns."

---

**Function spark_describe_1d**

**Function**: Describes a series (infers the variable type, then calculates type-specific values) for Spark DataFrames.

**Signature**:
```python
from ydata_profiling.model.spark.summary_spark import spark_describe_1d

def spark_describe_1d(
    config: Settings,
    series: DataFrame,
    summarizer: BaseSummarizer,
    typeset: VisionsTypeset,
) -> dict: ...
```

**Parameters**:
- config: Settings - report Settings object
- series: DataFrame - The Series (single column DataFrame) to describe
- summarizer: BaseSummarizer - Summarizer object
- typeset: VisionsTypeset - Typeset for type inference

**Returns**: dict - A dict containing calculated series description values

**Docstring**: "Describe a series (infer the variable type, then calculate type-specific values)."

---

**Function describe_boolean_1d_spark**

**Function**: Describes a boolean series in Spark, computing the most common value and its frequency.

**Signature**:
```python
from ydata_profiling.model.spark.describe_boolean_spark import describe_boolean_1d_spark

def describe_boolean_1d_spark(
    config: Settings, df: DataFrame, summary: dict
) -> Tuple[Settings, DataFrame, dict]: ...
```

**Parameters**:
- config: Settings - report Settings object
- df: DataFrame - The DataFrame containing the boolean column
- summary: dict - The dict containing the series description so far

**Returns**: Tuple[Settings, DataFrame, dict] - A tuple containing config, dataframe, and updated summary dict

**Docstring**: "Describe a boolean series."

---

**Function describe_categorical_1d_spark**

**Function**: Describes a categorical series in Spark, including first rows if not redacted.

**Signature**:
```python
from ydata_profiling.model.spark.describe_categorical_spark import describe_categorical_1d_spark

@describe_categorical_1d.register
def describe_categorical_1d_spark(
    config: Settings, df: DataFrame, summary: dict
) -> Tuple[Settings, DataFrame, dict]: ...
```

**Decorators**:
- `@describe_categorical_1d.register` - Registers this function as a multimethod implementation for categorical data in Spark

**Parameters**:
- config: Settings - report Settings object
- df: DataFrame - The DataFrame containing the categorical column
- summary: dict - The dict containing the series description so far

**Returns**: Tuple[Settings, DataFrame, dict] - A tuple containing config, dataframe, and updated summary dict

**Docstring**: "Describe a categorical series."

---

**Function describe_date_1d_spark**

**Function**: Describes a date series in Spark, computing min, max, range, and histogram.

**Signature**:
```python
from ydata_profiling.model.spark.describe_date_spark import describe_date_1d_spark

def describe_date_1d_spark(
    config: Settings, df: DataFrame, summary: dict
) -> Tuple[Settings, DataFrame, dict]: ...
```

**Parameters**:
- config: Settings - report Settings object
- df: DataFrame - The DataFrame containing the date column
- summary: dict - The dict containing the series description so far

**Returns**: Tuple[Settings, DataFrame, dict] - A tuple containing config, dataframe, and updated summary dict

**Docstring**: "Describe a date series."

---

**Function describe_numeric_1d_spark**

**Function**: Describes a numeric series in Spark DataFrame, computing comprehensive statistics optimized for distributed processing. Uses PySpark's aggregation functions for efficient computation.

**Signature**:
```python
from ydata_profiling.model.spark.describe_numeric_spark import describe_numeric_1d_spark

def describe_numeric_1d_spark(
    config: Settings, df: DataFrame, summary: dict
) -> Tuple[Settings, DataFrame, dict]: ...
```

**Parameters**:
- config: Settings - report Settings object containing configuration for quantiles and other settings
- df: DataFrame - The PySpark DataFrame containing the numeric column to analyze (should contain a single column)
- summary: dict - The dict containing the series description so far (must include 'value_counts' and 'n' keys)

**Returns**: Tuple[Settings, DataFrame, dict] - A tuple containing:
  - config: unmodified Settings object
  - df: unmodified DataFrame
  - summary: updated summary dict with the following statistics:
    - Basic statistics: mean, std, variance, min, max, sum
    - Distribution measures: skewness, kurtosis
    - Quantiles: percentiles specified in config.vars.num.quantiles (e.g., 5%, 25%, 50%, 75%, 95%)
    - Robust statistics: mad (median absolute deviation)
    - Count statistics: n_zeros, n_negative, n_infinite
    - Derived metrics: range, iqr (interquartile range), cv (coefficient of variation)
    - Proportions: p_zeros, p_negative, p_infinite
    - monotonic: set to 0 (not implemented for Spark due to lack of native ordering)
    - Histogram data for visualization

**Implementation Details**:
- Uses `numeric_stats_spark()` helper function for basic aggregations via PySpark SQL functions
- Computes approximate quantiles with 5% threshold using `df.stat.approxQuantile()`
- Filters infinite values from histogram computation
- Handles null/None values in aggregation results
- Note: Monotonicity detection not implemented for Spark backend (always returns 0)

**Docstring**: "Describe a boolean series." (Note: This is a documentation error in source code - should say "numeric series")

---

**Function describe_text_1d_spark**

**Function**: Describes a text/string series in Spark DataFrame. Provides sample rows for text inspection unless redaction is enabled. This is a minimal implementation compared to the pandas backend.

**Signature**:
```python
from ydata_profiling.model.spark.describe_text_spark import describe_text_1d_spark

def describe_text_1d_spark(
    config: Settings, df: DataFrame, summary: dict
) -> Tuple[Settings, DataFrame, dict]: ...
```

**Parameters**:
- config: Settings - report Settings object containing text variable configuration
- df: DataFrame - The PySpark DataFrame containing the text column to analyze (should contain a single column)
- summary: dict - The dict containing the series description so far

**Returns**: Tuple[Settings, DataFrame, dict] - A tuple containing:
  - config: unmodified Settings object
  - df: unmodified DataFrame
  - summary: updated summary dict with the following fields:
    - first_rows: pandas Series containing first 5 rows (only if config.vars.text.redact is False)

**Implementation Details**:
- Checks `config.vars.text.redact` setting to determine if text should be redacted
- If not redacted, uses `df.limit(5).toPandas().squeeze("columns")` to extract first 5 rows
- Converts Spark DataFrame to pandas for sample display
- Does not compute detailed text statistics (length, word counts, etc.) like pandas backend
- Minimal implementation focused on basic text preview

**Note**: This Spark implementation is significantly simpler than the pandas equivalent (`pandas_describe_text_1d`), which computes extensive text statistics including character counts, word counts, script analysis, etc. For full text analysis features, consider using the pandas backend.

**Docstring**: "Describe a categorical series." (Note: This is a documentation error in source code - should say "text series")

---

**Function get_duplicates_spark**

**Function**: Obtains the most occurring duplicate rows in the Spark DataFrame.

**Signature**:
```python
from ydata_profiling.model.spark.duplicates_spark import get_duplicates_spark

@get_duplicates.register
def get_duplicates_spark(
    config: Settings, df: DataFrame, supported_columns: Sequence
) -> Tuple[Dict[str, Any], Optional[DataFrame]]: ...
```

**Decorators**:
- `@get_duplicates.register` - Registers this function as a multimethod implementation for Spark DataFrames

**Parameters**:
- config: Settings - report Settings object
- df: DataFrame - the Spark DataFrame
- supported_columns: Sequence - the columns to consider

**Returns**: Tuple[Dict[str, Any], Optional[DataFrame]] - A tuple containing metrics dict and a subset of the DataFrame ordered by occurrence

**Docstring**: "Obtain the most occurring duplicate rows in the DataFrame."

---

**Function get_sample_spark**

**Function**: Obtains a sample from head of the Spark DataFrame (tail and random not implemented for Spark).

**Signature**:
```python
from ydata_profiling.model.spark.sample_spark import get_sample_spark

@get_sample.register
def get_sample_spark(config: Settings, df: DataFrame) -> List[Sample]: ...
```

**Decorators**:
- `@get_sample.register` - Registers this function as a multimethod implementation for Spark DataFrames

**Parameters**:
- config: Settings - Settings object
- df: DataFrame - the spark DataFrame

**Returns**: List[Sample] - a list of Sample objects

**Docstring**: "Obtains a sample from head and tail of the DataFrame"

---

**Function get_series_descriptions_spark**

**Function**: Computes series descriptions/statistics for all columns in a Spark DataFrame.

**Signature**:
```python
from ydata_profiling.model.spark.summary_spark import get_series_descriptions_spark

def get_series_descriptions_spark(
    config: Settings,
    df: DataFrame,
    summarizer: BaseSummarizer,
    typeset: VisionsTypeset,
    pbar: tqdm,
) -> dict: ...
    def describe_column(name: str) -> Tuple[str, dict]: ...
```

**Parameters**:
- config: Settings - report Settings object
- df: DataFrame - the Spark DataFrame to describe
- summarizer: BaseSummarizer - Summarizer object
- typeset: VisionsTypeset - Typeset for type inference
- pbar: tqdm - progress bar object

**Method**
- describe_column: It is an internal function of the get_series_descriptions_spark function, Describes a single column in the Spark DataFrame.

**Returns**: dict - A dict with the series descriptions for each column

---

**Function get_table_stats_spark**

**Function**: General statistics for the Spark DataFrame including row count, missing values, and variable type counts.

**Signature**:
```python
from ydata_profiling.model.spark.table_spark import get_table_stats_spark

@get_table_stats.register
def get_table_stats_spark(
    config: Settings, df: DataFrame, variable_stats: dict
) -> dict: ...
```

**Decorators**:
- `@get_table_stats.register` - Registers this function as a multimethod implementation for Spark table statistics

**Parameters**:
- config: Settings - report Settings object
- df: DataFrame - The Spark DataFrame to describe
- variable_stats: dict - Previously calculated statistic on the DataFrame

**Returns**: dict - A dictionary that contains the table statistics

**Docstring**: "General statistics for the DataFrame."

---

**Function spark_get_time_index_description_spark**

**Function**: Gets time index description for Spark DataFrame (currently returns empty dict - not implemented).

**Signature**:
```python
from ydata_profiling.model.spark.timeseries_index_spark import spark_get_time_index_description_spark

def spark_get_time_index_description_spark(
    config: Settings,
    df: DataFrame,
    table_stats: dict,
) -> dict: ...
```

**Parameters**:
- config: Settings - report Settings object
- df: DataFrame - The Spark DataFrame with time index
- table_stats: dict - Previously calculated table statistics

**Returns**: dict - Empty dictionary (not implemented for Spark)

---

**Function phi_k_compute**

**Function**: Computes Phi-K correlation for mixed data in Spark DataFrames. Filters columns by categorical_maximum_correlation_distinct threshold, unions numeric and supported columns, and uses pandas UDF for correlation calculation.

**Signature**:
```python
from ydata_profiling.model.spark.correlations_spark import phi_k_compute

def phi_k_compute(
    config: Settings, df: DataFrame, summary: dict
) -> Optional[pd.DataFrame]: ...
```

**Parameters**:
- config: Settings - report Settings object
- df: DataFrame - The Spark DataFrame
- summary: dict - Previously calculated summary statistics

**Returns**: Optional[pd.DataFrame] - Phi-K correlation matrix or None if insufficient columns

---

    Variable pandas_version_info: Imported via from ydata_profiling.utils.compat import pandas_version_info, used to store pandas version information.

**Logger and Display**

**Class ProfilingLogger**

**Signature**:
```python
from ydata_profiling.utils.logger import ProfilingLogger

class ProfilingLogger(logging.Logger):
    def __init__(
        self,
        name: str,
        level: int = logging.INFO
    ): ...
```

**Class**: Custom logger extending Python's logging.Logger. Tracks report profiling details (DataFrame type, data shape, report type, environment) and logs analytics features.

**Parameters**:
- `name: str` - Name of the logger instance
- `level: int` - Logging level (default: logging.INFO)

**Methods**:
```python
def info_def_report(self, df, timeseries: bool) -> None:
    """
    Logs information about report generation including dataframe details.

    Tracks:
    - DataFrame type (pandas or spark)
    - Data shape (rows and columns)
    - Report type (regular or compare)
    - Data type (timeseries or tabular)
    - Environment (Databricks detection)

    Sends analytics features and logs profiling characteristics.
    """
    ...
```

---

**Class DisplayInfo**

**Signature**:
```python
from ydata_profiling.utils.information import DisplayInfo

class DisplayInfo:
    def __init__(
        self,
        title: str,
        info_text: str,
        link: str = "https://ydata.ai/register"
    ): ...
```

**Class**: Information class for display configuration and settings. Used to display promotional messages and information to users.

**Parameters**:
- `title: str` - Title of the information message
- `info_text: str` - Main text content of the information message
- `link: str` - URL link for more information (default: "https://ydata.ai/register")

**Properties**:
```python
title: str
    """Title of the information message"""

link: str
    """URL link for more information"""

info_text: str
    """Main text content of the message"""
```

**Methods**:
```python
def display_message(self) -> None:
    """
    Display a formatted message to the user.

    - In Jupyter Notebook: Displays HTML formatted message with clickable link
    - In terminal: Displays colored text with link URL

    Uses IPython.display.HTML for Jupyter environments.
    """
    ...
```

**Constants**

**Import Method**: `from ydata_profiling.model.pandas import PANDAS_MODULES` or `from ydata_profiling.model.spark import SPARK_MODULES`

- Constant PANDAS_MODULES: List of pandas backend module names for dynamic import (correlations_pandas, describe_generic_pandas, describe_boolean_pandas, describe_categorical_pandas, describe_url_pandas, describe_file_pandas, describe_text_pandas, describe_timeseries_pandas, describe_numeric_pandas, describe_path_pandas, describe_image_pandas, describe_date_pandas, describe_counts_pandas, duplicates_pandas, sample_pandas, table_pandas, timeseries_index_pandas, summary_pandas).
- Constant SPARK_MODULES: List of Spark backend module names for dynamic import (correlations_spark, dataframe_spark, describe_boolean_spark, describe_categorical_spark, describe_counts_spark, describe_date_spark, describe_generic_spark, describe_numeric_spark, describe_supported_spark, duplicates_spark, missing_spark, sample_spark, summary_spark, table_spark, timeseries_index_spark, describe_text_spark).
- Constant CORRELATION_PEARSON: String constant "pearson" for Pearson correlation method identifier.
- Constant CORRELATION_SPEARMAN: String constant "spearman" for Spearman correlation method identifier.
- Constant _FLAVOUR_REGISTRY: Dictionary registry storing flavour mappings for HTML and Widget renderers.
- Constant HASH_PREFIX: String prefix "2@" for DataFrame hash values.
- Constant SUPPRESS_BANNER: Boolean flag from environment variable "YDATA_SUPPRESS_BANNER" to suppress startup banner display.

**Type Aliases and Module Exports**

**Import Method**: Module-level variables for controlling exports and display state

The `__all__` variable is defined in multiple modules to explicitly control what gets exported when using `from module import *`:

- `__all__` in `ydata_profiling.__init__`: Exports main API:
  ```python
  __all__ = [
      "pandas_decorator",
      "ProfileReport",
      "__version__",
      "compare",
  ]
  ```
- `__all__` in `pandas_profiling.__init__`: Backwards compatibility exports
- `__all__` in `ydata_profiling.model.__init__`: Exports BaseAnalysis, BaseDescription
- `__all__` in `ydata_profiling.model.pandas.__init__`: Exports all pandas backend functions
- `__all__` in `ydata_profiling.model.spark.__init__`: Exports all Spark backend functions
- `__all__` in `ydata_profiling.report.__init__`: Exports get_report_structure
- `__all__` in `ydata_profiling.report.presentation.core.__init__`: Exports core presentation classes
- `__all__` in `ydata_profiling.report.presentation.flavours.__init__`: Exports flavour-related items
- `__all__` in `ydata_profiling.report.presentation.flavours.html.__init__`: Exports HTML renderer classes
- `__all__` in `ydata_profiling.report.presentation.flavours.widget.__init__`: Exports Widget renderer classes
- `__all__` in `ydata_profiling.report.structure.variables.__init__`: Exports variable rendering functions


**Display State Variables**

**Variable _displayed_banner**

**Variable**: Boolean flag tracking whether the ydata-sdk upgrade banner has been displayed, used to prevent duplicate banner displays in the information display system.

**Declaration**:
```python
from ydata_profiling.utils.information import _displayed_banner

_displayed_banner = False
```

**Type**: bool

**Default Value**: False

**Usage**: Used in `ydata_profiling.utils.information` module to ensure the upgrade banner is only shown once per session.

---

**Variable _displayed_catvar_banner**

**Variable**: Boolean flag tracking whether the categorical variable analysis banner has been displayed, preventing repeated informational messages about categorical variable features.

**Declaration**:
```python
from ydata_profiling.model.pandas.describe_categorical_pandas import _displayed_catvar_banner

_displayed_catvar_banner = False
```

**Type**: bool

**Default Value**: False

**Usage**: Used in `ydata_profiling.model.pandas.describe_categorical_pandas` to show one-time informational messages about categorical variable analysis features.

**Comparison and Preprocessing Functions**

**Import Method**: `from ydata_profiling.compare_reports import [function_name]`

**Function validate_reports**

**Function**: Validates that reports are compatible for comparison, checking if at least two reports are provided.

**Signature**:
```python
from ydata_profiling.compare_reports import validate_reports

def validate_reports(
    reports: Union[List[ProfileReport], List[BaseDescription]], configs: List[dict]
) -> None: ...
```

**Parameters**:
- reports: Union[List[ProfileReport], List[BaseDescription]] - two or more reports to compare (may be ProfileReport or summary from report.get_description())
- configs: List[dict] - configuration dictionaries for each report

**Returns**: None

**Raises**:
- ValueError: If fewer than two reports are provided
- Warning: If more than two reports are compared (not fully supported)

**Docstring**: "Validate if the reports are comparable."

---

**Function parse_args**

**Function**: Parses the command line arguments for the `ydata_profiling` binary.

**Signature**:
```python
from ydata_profiling.controller.console import parse_args

def parse_args(args: Optional[List[Any]] = None) -> argparse.Namespace: ...
```

**Parameters**:
- args: Optional[List[Any]] - List of input arguments (Default value=None)

**Returns**: argparse.Namespace - Namespace with parsed arguments

**Docstring**: "Parse the command line arguments for the `ydata_profiling` binary."

---

**Internal Helper Functions**

These are internal implementation functions (prefixed with underscore) used throughout the codebase. They are documented here for completeness but are not part of the public API.

**Comparison and Merge Functions** (from `ydata_profiling.compare_reports`):

**Function _should_wrap**

**Function**: Determines if two values should be wrapped in a list during comparison operations.

**Signature**:
```python
from ydata_profiling.compare_reports import _should_wrap

def _should_wrap(v1: Any, v2: Any) -> bool: ...
```

**Parameters**:
- v1: Any - First value to compare
- v2: Any - Second value to compare

**Returns**: bool - False if v1 is list/dict, or True/False based on equality check (handles pandas objects and general equality)

**Function**: Internal function that determines wrapping logic for merge operations. Returns False for list/dict types. For pandas DataFrame/Series, uses .equals() method. For other types, performs equality comparison with ValueError handling.

---

**Function _update_merge_dict**

**Function**: Recursively merges two dictionaries, wrapping differing values in lists.

**Signature**:
```python
from ydata_profiling.compare_reports import _update_merge_dict

def _update_merge_dict(d1: Any, d2: Any) -> dict: ...
```

**Parameters**:
- d1: Any - First dictionary to merge
- d2: Any - Second dictionary to merge

**Returns**: dict - Merged dictionary with shared keys having values wrapped in lists if different

**Function**: Unwraps d1 and d2 in new dictionary to keep non-shared keys with **d1, **d2. For shared keys, if values are equal, takes that value as new value. If values are not equal, recursively merges them using _update_merge_mixed.

---

**Function _update_merge_seq**

**Function**: Merges two sequences (lists/tuples) while flattening nested structures.

**Signature**:
```python
from ydata_profiling.compare_reports import _update_merge_seq

def _update_merge_seq(d1: Any, d2: Any) -> Union[list, tuple]: ...
```

**Parameters**:
- d1: Any - First sequence to merge
- d2: Any - Second sequence to merge

**Returns**: Union[list, tuple] - Merged sequence, tuple for alerts, list for other cases

**Function**: Bundles values in a list/tuple, flattening them if they are already lists. Special handling for alerts (returns tuple). For list+list returns (d1, d2) tuple. For tuple+list extends tuple. Otherwise flattens and concatenates into single list.

---

**Function _update_merge_mixed**

**Function**: Dispatcher that calls appropriate merge function based on input types.

**Signature**:
```python
from ydata_profiling.compare_reports import _update_merge_mixed

def _update_merge_mixed(d1: Any, d2: Any) -> Union[dict, list, tuple]: ...
```

**Parameters**:
- d1: Any - First value to merge
- d2: Any - Second value to merge

**Returns**: Union[dict, list, tuple] - Result from _update_merge_dict if both are dicts, otherwise from _update_merge_seq

**Function**: Type dispatcher that routes to _update_merge_dict when both inputs are dictionaries, otherwise routes to _update_merge_seq.

---

**Function _update_merge**

**Function**: Main entry point for merging two dictionaries (or None with dict).

**Signature**:
```python
from ydata_profiling.compare_reports import _update_merge

def _update_merge(d1: Optional[dict], d2: dict) -> dict: ...
```

**Parameters**:
- d1: Optional[dict] - First dictionary (can be None for convenience in loops)
- d2: dict - Second dictionary

**Returns**: dict - Merged dictionary result

**Function**: For convenience in the loop, allows d1 to be empty initially. If d1 is None, returns d2. Raises TypeError if arguments are not dictionaries. Otherwise calls _update_merge_dict for the actual merge.

---

**Function _placeholders**

**Function**: Generates placeholder values in dataset descriptions for missing keys.

**Signature**:
```python
from ydata_profiling.compare_reports import _placeholders

def _placeholders(reports: List[BaseDescription]) -> None: ...
```

**Parameters**:
- reports: List[BaseDescription] - List of dataset description objects to process

**Returns**: None - Modifies reports in-place

**Docstring**: "Generates placeholders in the dataset descriptions where needed"

**Function**: Collects all unique keys from scatter and table["types"] across all reports. For each report, fills missing scatter[k1][k2] combinations with empty strings and missing type keys with 0 counts.

---

**Function _update_titles**

**Function**: Redefines report titles with default naming (Dataset A, B, C, etc.).

**Signature**:
```python
from ydata_profiling.compare_reports import _update_titles

def _update_titles(reports: List[ProfileReport]) -> None: ...
```

**Parameters**:
- reports: List[ProfileReport] - List of ProfileReport objects to update

**Returns**: None - Modifies reports in-place

**Docstring**: "Redefine title of reports with the default one."

**Function**: Iterates through reports and replaces title "YData Profiling Report" with "Dataset A", "Dataset B", etc. using chr(65 + idx) to generate letters.

---

**Function _compare_profile_report_preprocess**

**Function**: Preprocesses ProfileReport objects for comparison.

**Signature**:
```python
from ydata_profiling.compare_reports import _compare_profile_report_preprocess

def _compare_profile_report_preprocess(
    reports: List[ProfileReport],
    config: Optional[Settings] = None,
) -> Tuple[List[str], List[BaseDescription]]: ...
```

**Parameters**:
- reports: List[ProfileReport] - List of ProfileReport objects to preprocess
- config: Optional[Settings] - Optional configuration settings (default: None)

**Returns**: Tuple[List[str], List[BaseDescription]] - Tuple of (labels, descriptions)

**Function**: Extracts titles as labels. Handles color configuration for multi-report comparisons. Obtains description sets and assigns labels as analysis titles.

---

**Function _compare_dataset_description_preprocess**

**Function**: Preprocesses BaseDescription objects for comparison.

**Signature**:
```python
from ydata_profiling.compare_reports import _compare_dataset_description_preprocess

def _compare_dataset_description_preprocess(
    reports: List[BaseDescription],
) -> Tuple[List[str], List[BaseDescription]]: ...
```

**Parameters**:
- reports: List[BaseDescription] - List of BaseDescription objects to preprocess

**Returns**: Tuple[List[str], List[BaseDescription]] - Tuple of (labels, reports)

**Function**: Extracts analysis.title from each report as labels and returns tuple of (labels, reports).

---

**Function _apply_config**

**Function**: Applies configuration settings to comparison report for visualization purposes.

**Signature**:
```python
from ydata_profiling.compare_reports import _apply_config

def _apply_config(description: BaseDescription, config: Settings) -> BaseDescription: ...
```

**Parameters**:
- description: BaseDescription - Report summary to update
- config: Settings - The settings object for the ProfileReport

**Returns**: BaseDescription - The updated description

**Docstring**:
```
Apply the configuration for visualilzation purposes.

This handles the cases in which the report description
was computed prior to comparison with a different config

Args:
    description: report summary
    config: the settings object for the ProfileReport

Returns:
    the updated description
```

**Function**: Filters missing diagrams, correlations, samples, duplicates, and scatter plots based on config settings. Handles cases where report description was computed with different config.

---

**Function _is_alert_present**

**Function**: Checks if a specific alert is present in alerts list.

**Signature**:
```python
from ydata_profiling.compare_reports import _is_alert_present

def _is_alert_present(alert: Alert, alert_list: list) -> bool: ...
```

**Parameters**:
- alert: Alert - The alert to search for
- alert_list: list - List of alerts to search in

**Returns**: bool - True if alert with same column_name and alert_type exists in list

**Function**: Returns True if any alert in alert_list has matching column_name and alert_type with the input alert.

---

**Function _create_placehoder_alerts**

**Function**: Creates placeholder alerts for comparison reports.

**Signature**:
```python
from ydata_profiling.compare_reports import _create_placehoder_alerts

def _create_placehoder_alerts(report_alerts: tuple) -> tuple: ...
```

**Parameters**:
- report_alerts: tuple - Tuple of alert lists from multiple reports

**Returns**: tuple - Tuple of alert lists with placeholder alerts added

**Function**: Creates placeholder empty alerts for alerts that exist in one report but not others. Copies existing alerts and adds empty placeholder alerts (with _is_empty=True) where alerts are missing from other reports.

---

**Function _merge_dictionaries**

**Function**: Merges multiple dictionaries using recursive _update_merge logic.

**Signature**:
```python
from ydata_profiling.config import _merge_dictionaries

def _merge_dictionaries(dict1: dict, dict2: dict) -> dict: ...
```

**Parameters**:
- dict1: dict - Base dictionary to merge
- dict2: dict - Dictionary to merge on top of base dictionary

**Returns**: dict - Merged dictionary

**Docstring**:
```
Recursive merge dictionaries.

:param dict1: Base dictionary to merge.
:param dict2: Dictionary to merge on top of base dictionary.
:return: Merged dictionary
```

**Function**: Recursively merges dict1 into dict2. For each key in dict1, if value is dict, recursively merges with dict2's corresponding node. Otherwise, sets value in dict2 if key not present.

---

**Data Processing Functions**:

- **_redact_column** (from `ydata_profiling.model.summarizer`): Redacts sensitive column data when in sensitive mode
```python 
def _redact_column(column: Dict[str, Any]) -> Dict[str, Any]:
    def redact_key(data: Dict[str, Any]) -> Dict[str, Any]: ...
```
**Parameters**:
- column: Dict[str, Any] - Column dictionary to redact

**Function**: Redacts sensitive data in a column dictionary when in sensitive mode. Recursively applies redact_key to nested dictionaries.

**Method**:
- redact_key: Recursively redacts sensitive data in a nested dictionary.

**Returns**: Dict[str, Any] - Redacted column dictionary
---
- **_is_cast_type_defined** (from `ydata_profiling.model.pandas.summary_pandas`): Checks if a cast type is defined for a variable in the typeset
```python 
def _is_cast_type_defined(typeset: VisionsTypeset, variable: str) -> bool: ...
```
**Parameters**:
- typeset: VisionsTypeset - Typeset for type inference
- variable: str - Variable name to check cast type for

**Returns**: bool - True if cast type is defined for variable in typeset, False otherwise

**Function**: Checks if a cast type is defined for a variable in the typeset.

---


**Correlation Functions** (from `ydata_profiling.model.pandas.correlations_pandas`):

**Function _pairwise_spearman**

**Function**: Computes pairwise Spearman rank correlations between two columns.

**Signature**:
```python
from ydata_profiling.model.pandas.correlations_pandas import _pairwise_spearman

def _pairwise_spearman(col_1: pd.Series, col_2: pd.Series) -> float: ...
```

**Parameters**:
- col_1: pd.Series - First column series
- col_2: pd.Series - Second column series

**Returns**: float - Spearman correlation coefficient

**Function**: Wrapper that calls pandas Series.corr() method with method="spearman" to compute Spearman rank correlation.

---

**Function _pairwise_cramers**

**Function**: Computes pairwise Cramér's V correlations for categorical data.

**Signature**:
```python
from ydata_profiling.model.pandas.correlations_pandas import _pairwise_cramers

def _pairwise_cramers(col_1: pd.Series, col_2: pd.Series) -> float: ...
```

**Parameters**:
- col_1: pd.Series - First categorical column
- col_2: pd.Series - Second categorical column

**Returns**: float - Cramér's V correlation coefficient

**Function**: Creates crosstab between col_1 and col_2, then calls _cramers_corrected_stat with correction=True to compute bias-corrected Cramér's V statistic.

---

**Function _cramers_corrected_stat**

**Function**: Computes bias-corrected Cramér's V statistic for two variables.

**Signature**:
```python
from ydata_profiling.model.pandas.correlations_pandas import _cramers_corrected_stat

def _cramers_corrected_stat(confusion_matrix: pd.DataFrame, correction: bool) -> float: ...
```

**Parameters**:
- confusion_matrix: pd.DataFrame - Crosstab between two variables
- correction: bool - Should the correction be applied?

**Returns**: float - The Cramér's V corrected stat for the two variables

**Docstring**:
```
Calculate the Cramer's V corrected stat for two variables.

Args:
    confusion_matrix: Crosstab between two variables.
    correction: Should the correction be applied?

Returns:
    The Cramer's V corrected stat for the two variables.
```

**Function**: Handles empty crosstab by returning 0. Computes chi-squared statistic using scipy.stats.chi2_contingency. Calculates phi2 = chi2/n. Applies bias correction formula: phi2corr = max(0, phi2 - ((k-1)*(r-1))/(n-1)). Computes corrected dimensions rcorr and kcorr. Returns sqrt(phi2corr / min(kcorr-1, rcorr-1)) with special handling for division by zero.

---

**Function _compute_corr_natively**

**Function**: Computes correlation matrix using native Spark backend methods.

**Signature**:
```python
from ydata_profiling.model.spark.correlations_spark import _compute_corr_natively

def _compute_corr_natively(df: DataFrame, summary: dict, corr_type: str) -> ArrayType: ...
```

**Parameters**:
- df: DataFrame - Spark DataFrame to analyze
- summary: dict - Dictionary of variable descriptions
- corr_type: str - Correlation type ("pearson" or "spearman")

**Returns**: ArrayType - Correlation matrix as Spark array

**Docstring**:
```
This function exists as pearson and spearman correlation computations have the
exact same workflow. The syntax is Correlation.corr(dataframe, method="pearson" OR "spearman"),
and Correlation is from pyspark.ml.stat
```

**Function**: Filters numeric columns from summary. Converts DataFrame columns to vector using VectorAssembler. Uses handleInvalid="skip" for pyspark >= 2.4.0. Computes correlation using pyspark.ml.stat.Correlation.corr() with specified method.

---

**Rendering Helper Functions** (from `ydata_profiling.report.presentation` and `ydata_profiling.report.structure.variables`):

**Function _frequency_table**

**Function**: Generates internal frequency table for categorical variables.

**Signature**:
```python
from ydata_profiling.report.presentation.frequency_table_utils import _frequency_table

def _frequency_table(
    freqtable: pd.Series, n: int, max_number_to_print: int
) -> List[Dict[str, Any]]: ...
```

**Parameters**:
- freqtable: pd.Series - The frequency table (value counts)
- n: int - The total number of values
- max_number_to_print: int - Maximum number of observations to display

**Returns**: List[Dict[str, Any]] - List of dictionaries containing label, width, count, percentage, n, and extra_class for each row

**Function**: Generates frequency table rows with percentage bars. Limits output to max_number_to_print rows. Computes freq_other for remaining values and freq_missing for missing values. Creates rows with normalized widths (freq/max_freq), counts, and percentages. Adds "Other values" and "(Missing)" rows if their frequencies exceed min_freq.

---

**Function _extreme_obs_table**

**Function**: Generates table of extreme observations (min/max values).

**Signature**:
```python
from ydata_profiling.report.presentation.frequency_table_utils import _extreme_obs_table

def _extreme_obs_table(
    freqtable: pd.Series, number_to_print: int, n: int
) -> List[Dict[str, Any]]: ...
```

**Parameters**:
- freqtable: pd.Series - The (sorted) frequency table
- number_to_print: int - The number of observations to print
- n: int - The total number of observations

**Returns**: List[Dict[str, Any]] - List of dictionaries with label, width, count, percentage, extra_class, and n

**Function**: Similar to frequency table but for extreme observations. Takes first number_to_print observations. Computes max frequency for normalization. Creates rows with normalized widths, counts, and percentages.

---

**Function _get_n**

**Function**: Gets the n value (sample size) for rendering purposes.

**Signature**:
```python
from ydata_profiling.report.structure.variables.render_categorical import _get_n

def _get_n(value: Union[list, pd.DataFrame]) -> Union[int, List[int]]: ...
```

**Parameters**:
- value: Union[list, pd.DataFrame] - Value counts as DataFrame or list of DataFrames

**Returns**: Union[int, List[int]] - Sum of values (single int or list of ints for comparison mode)

**Docstring**: "Helper function to deal with multiple values"

**Function**: If value is list, returns list of sums for each DataFrame. Otherwise returns single sum of DataFrame values.

---

**Function _render_gap_tab**

**Function**: Renders the gap analysis tab for timeseries variables.

**Signature**:
```python
from ydata_profiling.report.structure.variables.render_timeseries import _render_gap_tab

def _render_gap_tab(config: Settings, summary: dict) -> Container: ...
```

**Parameters**:
- config: Settings - Report configuration settings
- summary: dict - Variable summary dictionary containing gap_stats

**Returns**: Container - Container with gap statistics table and gap analysis plot

**Function**: Creates gap statistics table with number of gaps, min, max, mean, median gap durations (formatted as timespans). Includes gap analysis plot showing timeseries with highlighted gap regions. Returns Container with both table and visualization.

---

**Plotting Functions** (from `ydata_profiling.visualisation.plot` and `ydata_profiling.utils.common`):

**Function _copy**

**Function**: Internal copy function for pathlib objects (monkeypatch).

**Signature**:
```python
from ydata_profiling.utils.common import _copy

def _copy(self, target): ...
```

**Parameters**:
- self: Path object (pathlib.Path)
- target: Target path to copy to

**Returns**: None

**Docstring**:
```
Monkeypatch for pathlib

Args:
    self:
    target:

Returns:

```

**Function**: Asserts that self is a file, then uses shutil.copy to copy the file from str(self) to target.

---

**Function _plot_histogram**

**Function**: Internal histogram plotting function.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _plot_histogram

def _plot_histogram(
    config: Settings,
    series: np.ndarray,
    bins: Union[int, np.ndarray],
    figsize: tuple = (6, 4),
    date: bool = False,
    hide_yaxis: bool = False,
) -> plt.Figure: ...
```

**Parameters**:
- config: Settings - The Settings object
- series: np.ndarray - The data to plot
- bins: Union[int, np.ndarray] - Number of bins (int for equal size, ndarray for variable size)
- figsize: tuple - The size of the figure (width, height) in inches, default (6,4)
- date: bool - Is the x-axis of date type (default: False)
- hide_yaxis: bool - Hide the y-axis (default: False)

**Returns**: plt.Figure - The histogram plot

**Docstring**:
```
Plot a histogram from the data and return the AxesSubplot object.

Args:
    config: the Settings object
    series: The data to plot
    bins: number of bins (int for equal size, ndarray for variable size)
    figsize: The size of the figure (width, height) in inches, default (6,4)
    date: is the x-axis of date type

Returns:
    The histogram plot.
```

**Function**: Handles both single series and comparison mode (list of series). For comparison mode, plots multiple overlapping histograms with different colors. Applies date formatting if date=True. Optionally hides x-axis labels and y-axis based on config settings.

---

**Function _plot_word_cloud**

**Function**: Internal word cloud generation function for text variables.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _plot_word_cloud

def _plot_word_cloud(
    config: Settings,
    series: Union[pd.Series, List[pd.Series]],
    figsize: tuple = (6, 4),
) -> plt.Figure: ...
```

**Parameters**:
- config: Settings - Report configuration settings
- series: Union[pd.Series, List[pd.Series]] - Word frequency series or list of series
- figsize: tuple - Figure size (width, height) in inches, default (6, 4)

**Returns**: plt.Figure - The word cloud plot

**Function**: Converts series to list if single series. For each series, converts to dictionary and generates word cloud using WordCloud with configured font_path, white background, random_state=123, width=300, height=200, scale=2. Creates subplot for each series and displays with axis off.

---

**Function _format_ts_date_axis**

**Function**: Formats the date axis for timeseries plots.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _format_ts_date_axis

def _format_ts_date_axis(
    series: pd.Series,
    axis: matplotlib.axis.Axis,
) -> matplotlib.axis.Axis: ...
```

**Parameters**:
- series: pd.Series - The timeseries data
- axis: matplotlib.axis.Axis - The matplotlib axis to format

**Returns**: matplotlib.axis.Axis - The formatted axis

**Function**: Checks if series.index is pd.DatetimeIndex. If true, sets AutoDateLocator and ConciseDateFormatter for x-axis. Returns the axis.

---

**Function _plot_timeseries**

**Function**: Internal timeseries plotting function.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _plot_timeseries

def _plot_timeseries(
    config: Settings,
    series: Union[list, pd.Series],
    figsize: tuple = (6, 4),
) -> matplotlib.figure.Figure: ...
```

**Parameters**:
- config: Settings - Report configuration
- series: Union[list, pd.Series] - The data to plot (single series or list for comparison)
- figsize: tuple - The size of the figure (width, height) in inches, default (6,4)

**Returns**: matplotlib.figure.Figure - The TimeSeries lineplot

**Docstring**:
```
Plot an line plot from the data and return the AxesSubplot object.
Args:
    series: The data to plot
    figsize: The size of the figure (width, height) in inches, default (6,4)
Returns:
    The TimeSeries lineplot.
```

**Function**: Creates figure with subplot. For list mode, plots each series with different colors and labels from config. Formats date axis if DatetimeIndex. For single series, plots with primary color. Returns plot object.

---

**Function _get_ts_lag**

**Function**: Gets lag values for timeseries autocorrelation analysis.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _get_ts_lag

def _get_ts_lag(config: Settings, series: pd.Series) -> int: ...
```

**Parameters**:
- config: Settings - Configuration with pacf_acf_lag setting
- series: pd.Series - The timeseries data

**Returns**: int - The lag value to use

**Function**: Gets lag from config.vars.timeseries.pacf_acf_lag. Computes max_lag_size = (len(series) // 2) - 1. Returns minimum of lag and max_lag_size using np.min.

---

**Function _plot_acf_pacf**

**Function**: Plots autocorrelation (ACF) and partial autocorrelation (PACF) functions.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _plot_acf_pacf

def _plot_acf_pacf(
    config: Settings, series: pd.Series, figsize: tuple = (15, 5)
) -> str: ...
```

**Parameters**:
- config: Settings - Report configuration
- series: pd.Series - The timeseries data
- figsize: tuple - Figure size, default (15, 5)

**Returns**: str - Encoded plot string

**Function**: Gets primary color from config. Computes lag using _get_ts_lag. Creates 1x2 subplot. Plots ACF using statsmodels.graphics.tsaplots.plot_acf with fft=True. Plots PACF using plot_pacf with method="ywm". Sets colors for both plots and PolyCollection facecolors. Returns encoded plot.

---

**Function _plot_acf_pacf_comparison**

**Function**: Plots ACF/PACF comparison for multiple series.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _plot_acf_pacf_comparison

def _plot_acf_pacf_comparison(
    config: Settings, series: List[pd.Series], figsize: tuple = (15, 5)
) -> str: ...
```

**Parameters**:
- config: Settings - Report configuration
- series: List[pd.Series] - List of timeseries to compare
- figsize: tuple - Figure size, default (15, 5)

**Returns**: str - Encoded plot string

**Function**: Creates comparison color list. Creates n_labels x 2 subplot grid. For each series, computes lag and plots ACF and PACF with corresponding color. Sets titles only for first row. Colors PolyCollection items for each subplot. Returns encoded plot.

---

**Function _set_visibility**

**Function**: Sets visibility properties of plot elements.

**Signature**:
```python
from ydata_profiling.visualisation.plot import _set_visibility

def _set_visibility(
    axis: matplotlib.axis.Axis, tick_mark: str = "none"
) -> matplotlib.axis.Axis: ...
```

**Parameters**:
- axis: matplotlib.axis.Axis - The matplotlib axis to modify
- tick_mark: str - Tick position setting, default "none"

**Returns**: matplotlib.axis.Axis - The modified axis

**Function**: Sets all four spines (top, right, bottom, left) to invisible. Sets x-axis and y-axis tick positions to tick_mark value. Returns the axis.

---

**Note**: These are internal functions and may change without notice. Users should rely on the public API functions instead.

### DataFrame Utility Functions

**Function rename_index**

**Function**: Renames DataFrame indices or columns named 'index' to 'df_index' to avoid naming conflicts.

**Signature**:
```python
from ydata_profiling.utils.dataframe import rename_index

def rename_index(df: pd.DataFrame) -> pd.DataFrame: ...
```

**Parameters**:
- `df: pd.DataFrame` - DataFrame to process

**Returns**: `pd.DataFrame` - The DataFrame with 'index' column/index renamed to 'df_index', or unchanged if no such name exists

**Implementation**:
- Renames any column named "index" to "df_index" using `df.rename(columns={"index": "df_index"}, inplace=True)`
- If the index has a level named "index", renames it to "df_index" in the index.names list
- Modifies the DataFrame in-place and returns it

**Use Case**: Prevents errors when a DataFrame contains a column or index named 'index', which can conflict with pandas operations.

**Docstring**: "If the DataFrame contains a column or index named `index`, this will produce errors. We rename the {index,column} to be `df_index`."

---

**Function hash_dataframe**

**Function**: Computes a SHA256 hash of a DataFrame for caching and comparison purposes.

**Signature**:
```python
from ydata_profiling.utils.dataframe import hash_dataframe

def hash_dataframe(df: pd.DataFrame) -> str: ...
```

**Parameters**:
- `df: pd.DataFrame` - The DataFrame to hash

**Returns**: `str` - A hash string with format "{HASH_PREFIX}{hex_digest}" where HASH_PREFIX is a constant prefix

**Implementation Details**:
- Uses `pandas.util.hash_pandas_object(df)` to generate hash values for each row (returns Series of uint64)
- Converts hash values to strings and joins them with newlines
- Computes SHA256 digest of the concatenated string: `hashlib.sha256(hash_values.encode("utf-8")).hexdigest()`
- Prepends a constant HASH_PREFIX to the digest
- Uses human-readable string representation instead of binary for portability across architectures

**Use Case**: Used for caching profiling results and detecting DataFrame changes.

**Docstring**: "Hash a DataFrame (implementation might change in the future)"

---

**Function slugify**

**Function**: Converts a string to a URL-safe slug format (lowercase, alphanumeric with dashes).

**Signature**:
```python
from ydata_profiling.utils.dataframe import slugify

def slugify(value: str, allow_unicode: bool = False) -> str: ...
```

**Parameters**:
- `value: str` - The string to convert
- `allow_unicode: bool` - Whether to allow Unicode characters (default: False)

**Returns**: `str` - Slugified string suitable for URLs or filenames

**Transformation Steps**:
1. Convert value to string
2. If `allow_unicode=True`: Normalize using NFKC form
3. If `allow_unicode=False`: Normalize using NFKD, encode to ASCII (ignoring errors), decode back to string
4. Convert to lowercase
5. Remove non-alphanumeric characters (except underscores and hyphens) using regex `[^\w\s-]`
6. Replace spaces and repeated dashes with single dashes using regex `[-\s]+`
7. Strip leading/trailing dashes and underscores



**Origin**: Taken from Django's `django.utils.text.py`

**Docstring**: "Convert to ASCII if 'allow_unicode' is False. Convert spaces or repeated dashes to single dashes. Remove characters that aren't alphanumerics, underscores, or hyphens. Convert to lowercase. Also strip leading and trailing whitespace, dashes, and underscores."

---

**Function extract_zip**

**Function**: Extracts a ZIP archive to a specified directory.

**Signature**:
```python
from ydata_profiling.utils.common import extract_zip

def extract_zip(outfile, effective_path): ...
```

**Parameters**:
- `outfile` - Path to the ZIP file to extract
- `effective_path` - Target directory path for extraction

**Returns**: None (extracts files to disk)

**Implementation**:
- Opens the ZIP file using `zipfile.ZipFile(outfile)` as context manager
- Extracts all contents to `effective_path` using `z.extractall(effective_path)`
- Catches `zipfile.BadZipFile` exceptions and raises `ValueError("Bad zip file")` with chaining

**Error Handling**:
Raises `ValueError` with message "Bad zip file" if the file is not a valid ZIP archive

**Use Case**: Used internally for extracting downloaded datasets or report templates.

---

**Function describe_column** (Internal Helper)

**Function**: Internal helper function used within parallel processing to describe a single column/series.

**Context**: This is a nested function defined inside `get_series_descriptions_pandas` in `src/ydata_profiling/model/pandas/summary_pandas.py`. It is not meant to be imported or used directly.

**Signature**:
```python

# Internal function - not for direct import
def describe_column(name: str, series: pd.Series) -> Tuple[str, dict]:
    """Process a single series to get the column description."""
    ...
```

**Parameters**:
- `name: str` - Column name
- `series: pd.Series` - The pandas Series to describe

**Returns**: `Tuple[str, dict]` - Tuple of (column_name, description_dict)

**Implementation**:
- Updates progress bar with current column name: `pbar.set_postfix_str(f"Describe variable: {name}")`
- Calls `pandas_describe_1d(config, series, summarizer, typeset)` to compute statistics
- Updates progress bar: `pbar.update()`
- Returns column name and description

**Usage Context**: Used with `ThreadPoolExecutor` for parallel column profiling:
```python
with ThreadPoolExecutor(max_workers=pool_size) as executor:
    future_to_col = {
        executor.submit(describe_column, name, series): name
        for name, series in df.items()
    }
```

**Note**: This function captures variables from the enclosing scope (config, summarizer, typeset, pbar) via closure.

**Docstring**: "Process a single series to get the column description."

---

**Decorator and Type System Functions**

**Function compose**

**Import Method**: `from ydata_profiling.model.handler import compose`

**Signature**:
```python
def compose(functions: Sequence[Callable]) -> Callable
    def composed_function(*args) -> List[Any]: ...

```

**Parameters**:
- `functions: Sequence[Callable]` - Sequence of functions to compose

**Method**:
- `composed_function(*args) -> List[Any]` - It is an internal function of the compose function
, Applies all functions in sequence to input arguments

**Returns**: `Callable` - Combined function applying all functions in order

**Docstring**:
```
Compose a sequence of functions.

:param functions: sequence of functions
:return: combined function applying all functions in order.
```

**Function**: Composes a sequence of functions. Internally defines `composed_function` that receives input arguments, applies each function in sequence, unpacking tuples when necessary, otherwise passing results directly.

**Algorithm**:
```
1. Define inner function composed_function(*args) -> List[Any]
2. Start with input arguments (result = args)
3. For each function in functions:
   - If current result is tuple: call func(*result)
   - Otherwise: call func(result)
   - Assign return value to result
4. Return final result
```

**Function get_render_map**

**Import Method**: `from ydata_profiling.model.handler import get_render_map`

**Signature**:
```python
def get_render_map() -> Dict[str, Callable]
```

**Function**: Gets rendering map dictionary that maps data types to their corresponding rendering functions. Imports all render algorithms from `ydata_profiling.report.structure.variables` and creates the mapping.

**Returns**: `Dict[str, Callable]` - Dictionary containing the following type-to-function mappings:
- "Boolean" → render_boolean
- "Numeric" → render_real
- "Complex" → render_complex
- "Text" → render_text
- "DateTime" → render_date
- "Categorical" → render_categorical
- "URL" → render_url
- "Path" → render_path
- "File" → render_file
- "Image" → render_image
- "Unsupported" → render_generic
- "TimeSeries" → render_timeseries

- **Function func_nullable_series_contains**: Decorator for nullable series operations.

**Signature**:
```python
def func_nullable_series_contains(fn: Callable) -> Callable
    @functools.wraps(fn)
    def inner(
        config: Settings, series: pd.Series, state: dict, *args, **kwargs
    ) -> bool: ...
```

**Parameters**:
- `fn: Callable` - Function to decorate

**Method**:
- `inner(config: Settings, series: pd.Series, state: dict, *args, **kwargs) -> bool` - It is an internal function of the func_nullable_series_contains function, It handles nullable series operations by dropping NaN values before processing.

**Returns**: `bool` - Result of the decorated function, or False if series is empty after dropping nulls

**Docstring**: `"""Decorator for nullable series"""`

- **Function series_hashable**: Decorator ensuring series is hashable.

**Signature**:
```python
def series_hashable(
    fn: Callable[[Settings, pd.Series, dict], Tuple[Settings, pd.Series, dict]]
) -> Callable[[Settings, pd.Series, dict], Tuple[Settings, pd.Series, dict]]:
    @functools.wraps(fn)
    def inner(
        config: Settings, series: pd.Series, summary: dict
    ) -> Tuple[Settings, pd.Series, dict]: ...
```

**Parameters**:
- `fn: Callable[[Settings, pd.Series, dict], Tuple[Settings, pd.Series, dict]]` - Function to decorate

**Method**:
- `inner(config: Settings, series: pd.Series, summary: dict) -> Tuple[Settings, pd.Series, dict]` - It is an internal function of the series_hashable function, It checks if series values are hashable before processing. If `summary["hashable"]` is False, it returns immediately without calling the decorated function. This prevents errors when attempting operations that require hashable values (e.g., value_counts) on unhashable types (e.g., lists, dicts).

**Returns**: `Tuple[Settings, pd.Series, dict]` - Result of the decorated function, or (config, series, summary) unchanged if not hashable

**Docstring**: `"""Decorator that checks if series values are hashable before processing."""`

**Algorithm**:
```
1. Check if summary["hashable"] is False
2. If not hashable: return (config, series, summary) unchanged
3. If hashable: call the decorated function normally
```

- **Function series_handle_nulls**: Decorator handling null values in series.

**Signature**:
```python
def series_handle_nulls(
    fn: Callable[[Settings, pd.Series, dict], Tuple[Settings, pd.Series, dict]]
) -> Callable[[Settings, pd.Series, dict], Tuple[Settings, pd.Series, dict]]:
    @functools.wraps(fn)
    def inner(
        config: Settings, series: pd.Series, summary: dict
    ) -> Tuple[Settings, pd.Series, dict]:
```

**Docstring**: `"""Decorator for nullable series"""`
**Parameters**:
- `fn: Callable[[Settings, pd.Series, dict], Tuple[Settings, pd.Series, dict]]` - Function to decorate

**Method**:
- `inner(config: Settings, series: pd.Series, summary: dict) -> Tuple[Settings, pd.Series, dict]` - It is an internal function of the series_handle_nulls function, It handles nullable series operations by dropping NaN values before processing.

**Returns**: `Tuple[Settings, pd.Series, dict]` - Result of the decorated function, or (config, series, summary) unchanged if no nulls

**Docstring**: `"""Decorator that handles null values in series before processing."""`

**Algorithm**:
```
1. Check if series.hasnans is True
2. If has NaNs: series = series.dropna()
3. Call the decorated function with cleaned series
4. Return result
```

- **Function named_aggregate_summary**: Generates aggregate statistics with named keys.

**Signature**:
```python
def named_aggregate_summary(series: pd.Series, key: str) -> dict
```

**Function**: Generates a dictionary of aggregate statistics (max, mean, median, min) for a pandas Series, with keys prefixed by the provided key name.

**Returns**:
```python
{
    f"max_{key}": np.max(series),
    f"mean_{key}": np.mean(series),
    f"median_{key}": np.median(series),
    f"min_{key}": np.min(series),
}
```

**Function typeset_types**

**Function**: Defines types based on the config, creating a set of Visions base types for data profiling.

**Signature**:
```python
from ydata_profiling.model.typeset import typeset_types

def typeset_types(config: Settings) -> Set[visions.VisionsBaseType]: ...
```

**Parameters**:
- config: Settings - Configuration settings

**Returns**: Set[visions.VisionsBaseType] - Set of defined types for profiling

**Docstring**: "Define types based on the config"

---

**Function is_nullable**

**Function**: Checks if a series has non-null values (count > 0).

**Signature**:
```python
from ydata_profiling.model.typeset_relations import is_nullable

def is_nullable(series: pd.Series, state: dict) -> bool: ...
```

**Parameters**:
- series: pd.Series - The series to check
- state: dict - State dictionary

**Returns**: bool - True if series count > 0

---

**Function try_func**

**Function**: Decorator that wraps a function in try-except, returning False on any exception.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import try_func

def try_func(fn: Callable) -> Callable: ...
    @functools.wraps(fn)
    def inner(series: pd.Series, *args, **kwargs) -> bool ...
```

**Parameters**:
- fn: Callable - Function to wrap

**Method**:
- `inner(series: pd.Series, *args, **kwargs) -> bool` - It is an internal function of the try_func function, It wraps a function in a try-except block, returning False on any exception.

**Returns**: Callable - Wrapped function that returns False on exception

---

**Function string_is_bool**

**Function**: Tests if a string series represents boolean values based on configured mappings.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import string_is_bool

def string_is_bool(series: pd.Series, state: dict, k: Dict[str, bool]) -> bool: ...
    @series_handle_nulls
    @try_func
    def tester(s: pd.Series, state: dict) -> bool: ...
```

**Parameters**:
- series: pd.Series - The series to test
- state: dict - State dictionary
- k: Dict[str, bool] - Boolean mapping dictionary

**Method**:
- `tester(s: pd.Series, state: dict) -> bool` - It is an internal function of the string_is_bool function, It tests if a string series represents boolean values based on configured mappings.

**Returns**: bool - True if all non-null values match boolean mappings

---

**Function tester**

**Function**: Generic tester function (internal helper within string_is_bool).

**Note**: This is an internal nested function decorated with @series_handle_nulls and @try_func.

---

**Function string_to_bool**

**Function**: Converts string series to boolean using lowercase mapping.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import string_to_bool

def string_to_bool(series: pd.Series, state: dict, k: Dict[str, bool]) -> pd.Series: ...
```

**Parameters**:
- series: pd.Series - The series to convert
- state: dict - State dictionary
- k: Dict[str, bool] - Boolean mapping dictionary

**Returns**: pd.Series - Series with boolean values

---

**Function numeric_is_category**

**Function**: Tests if a numeric series should be treated as categorical based on unique value threshold.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import numeric_is_category

def numeric_is_category(series: pd.Series, state: dict, k: Settings) -> bool: ...
```

**Parameters**:
- series: pd.Series - The series to test
- state: dict - State dictionary
- k: Settings - Settings object with threshold configuration

**Returns**: bool - True if 1 <= n_unique <= threshold

---

**Function to_category**

**Function**: Converts series to categorical string type, handling NaN values appropriately.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import to_category

def to_category(series: pd.Series, state: dict) -> pd.Series: ...
```

**Parameters**:
- series: pd.Series - The series to convert
- state: dict - State dictionary

**Returns**: pd.Series - Series as string type

---

**Function series_is_string**

**Function**: Tests if a series contains string values.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import series_is_string

@series_handle_nulls
def series_is_string(series: pd.Series, state: dict) -> bool: ...
```

**Decorators**:
- `@series_handle_nulls` - Handles null values before testing

**Parameters**:
- series: pd.Series - The series to test
- state: dict - State dictionary

**Returns**: bool - True if series contains strings

---

**Function string_is_category**

**Function**: Tests if a string series should be treated as categorical based on cardinality and uniqueness thresholds.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import string_is_category

@series_handle_nulls
def string_is_category(series: pd.Series, state: dict, k: Settings) -> bool: ...
```

**Decorators**:
- `@series_handle_nulls` - Handles null values before testing

**Parameters**:
- series: pd.Series - The series to test
- state: dict - State dictionary
- k: Settings - Settings object with threshold configuration

**Returns**: bool - True if series meets categorical criteria

**Docstring**: "String is category, if the following conditions are met: has at least one and less or equal distinct values as threshold, (distinct values / count of all values) is less than threshold, is not bool"

---

**Function string_is_datetime**

**Function**: Tests if a string series represents datetime values.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import string_is_datetime

@series_handle_nulls
def string_is_datetime(series: pd.Series, state: dict) -> bool: ...
```

**Decorators**:
- `@series_handle_nulls` - Handles null values before testing

**Parameters**:
- series: pd.Series - The series to test
- state: dict - State dictionary

**Returns**: bool - True if series can be converted to datetime with at least one valid date

**Docstring**: "If we can transform data to datetime and at least one is valid date."

---

**Function string_is_numeric**

**Function**: Tests if a string series represents numeric values (excluding booleans and categoricals).

**Signature**:
```python
from ydata_profiling.model.typeset_relations import string_is_numeric

@series_handle_nulls
def string_is_numeric(series: pd.Series, state: dict, k: Settings) -> bool: ...
```

**Decorators**:
- `@series_handle_nulls` - Handles null values before testing

**Parameters**:
- series: pd.Series - The series to test
- state: dict - State dictionary
- k: Settings - Settings object with threshold configuration

**Returns**: bool - True if series can be converted to numeric and is not categorical

---

**Function string_to_datetime**

**Function**: Converts string series to datetime, handling different pandas versions.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import string_to_datetime

def string_to_datetime(series: pd.Series, state: dict) -> pd.Series: ...
```

**Parameters**:
- series: pd.Series - The series to convert
- state: dict - State dictionary

**Returns**: pd.Series - Series with datetime values

---

**Function string_to_numeric**

**Function**: Converts string series to numeric, coercing errors to NaN.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import string_to_numeric

def string_to_numeric(series: pd.Series, state: dict) -> pd.Series: ...
```

**Parameters**:
- series: pd.Series - The series to convert
- state: dict - State dictionary

**Returns**: pd.Series - Series with numeric values

---

**Function to_bool**

**Function**: Converts series to boolean type, using nullable boolean if series has NaNs.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import to_bool

def to_bool(series: pd.Series) -> pd.Series: ...
```

**Parameters**:
- series: pd.Series - The series to convert

**Returns**: pd.Series - Series with boolean type

---

**Function object_is_bool**

**Function**: Tests if an object-dtype series contains only boolean values.

**Signature**:
```python
from ydata_profiling.model.typeset_relations import object_is_bool

@series_handle_nulls
def object_is_bool(series: pd.Series, state: dict) -> bool: ...
```

**Decorators**:
- `@series_handle_nulls` - Handles null values before testing

**Parameters**:
- series: pd.Series - The series to test
- state: dict - State dictionary

**Returns**: bool - True if series contains only True/False values

---

**Statistical and Analysis Helper Functions**

- **Function chi_square**: Performs chi-square goodness-of-fit test.

**Signature**:
```python
def chi_square(
    values: Optional[np.ndarray] = None, histogram: Optional[np.ndarray] = None
) -> dict
```

**Function**: Performs chi-square goodness-of-fit test on values or histogram. Uses scipy.stats.chisquare to test if the observed distribution matches a uniform distribution.

**Parameters**:
- `values`: Optional numpy array of values. If provided and histogram is None, computes histogram with 'auto' bins
- `histogram`: Optional pre-computed histogram array

**Returns**:
```python
{
    "statistic": float,  # Chi-square test statistic
    "pvalue": float      # P-value of the test
}
```

**Algorithm**:
```
1. If histogram is None:
   - Compute bins using np.histogram_bin_edges(values, bins="auto")
   - Compute histogram with np.histogram(values, bins)
2. If histogram is empty or sum is 0: return {"statistic": 0, "pvalue": 0}
3. Perform chi-square test using scipy.stats.chisquare(histogram)
4. Convert result to dict and return
```

**Summary and Statistics Functions**

These functions generate summary statistics for various data types:

**Function named_aggregate_summary**

**Function**: Creates named aggregate summary statistics (max, mean, median, min) for a series with a given key prefix.

**Signature**:
```python
from ydata_profiling.model.summary_algorithms import named_aggregate_summary

def named_aggregate_summary(series: pd.Series, key: str) -> dict: ...
```

**Parameters**:
- series: pd.Series - The series to summarize
- key: str - Key prefix for the summary statistics

**Returns**: dict - Dictionary with max_{key}, mean_{key}, median_{key}, min_{key}

---

**Text Analysis Functions** (from `ydata_profiling.model.pandas.describe_categorical_pandas`):

**Function get_character_counts_vc**

**Function**: Gets character counts using value_counts method.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_categorical_pandas import get_character_counts_vc

def get_character_counts_vc(vc: pd.Series) -> pd.Series: ...
```

**Parameters**:
- vc: pd.Series - Series with unique values as index and frequencies as values

**Returns**: pd.Series - Character counts sorted by frequency (descending)

**Function**: Creates series from vc.index, filters out empty strings, splits into individual characters using apply(list) and explode(). Creates weighted character counts by grouping and summing. Filters out zero-length strings and sorts by frequency descending.

---

**Function get_character_counts**

**Function**: Gets character counts from text series.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_categorical_pandas import get_character_counts

def get_character_counts(series: pd.Series) -> Counter: ...
```

**Parameters**:
- series: pd.Series - The Series to process

**Returns**: Counter - A Counter object with character counts

**Docstring**:
```
Function to return the character counts

Args:
    series: the Series to process

Returns:
    A dict with character counts
```

**Function**: Concatenates all strings in series using series.str.cat() and returns Counter of all characters.

---

**Function counter_to_series**

**Function**: Converts Counter object to pandas Series.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_categorical_pandas import counter_to_series

def counter_to_series(counter: Counter) -> pd.Series: ...
```

**Parameters**:
- counter: Counter - Counter object to convert

**Returns**: pd.Series - Series with counter items as index and counts as values

**Function**: Returns empty Series if counter is empty. Otherwise calls counter.most_common(), unzips into items and counts, returns Series with counts indexed by items.

---

**Function unicode_summary_vc**

**Function**: Gets unicode character summary using value_counts.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_categorical_pandas import unicode_summary_vc

def unicode_summary_vc(vc: pd.Series) -> dict: ...
```

**Parameters**:
- vc: pd.Series - Series with unique values as index and frequencies as values

**Returns**: dict - Dictionary with unicode character analysis including n_characters_distinct, n_characters, character_counts, category_alias_values, block_alias_values

**Function**: Gets character counts using get_character_counts_vc. Attempts to import tangled_up_in_unicode for block, category, script functions, falls back to unicodedata.category if unavailable. Computes character-to-block, character-to-category, and character-to-script mappings. Returns summary with distinct character count, total character count, character counts series, category aliases, and block aliases.

---

**Function word_summary_vc**

**Function**: Gets word summary using value_counts.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_categorical_pandas import word_summary_vc

def word_summary_vc(vc: pd.Series, stop_words: List[str] = []) -> dict: ...
```

**Parameters**:
- vc: pd.Series - Series containing all unique categories as index and their frequency as value
- stop_words: List[str] - List of stop words to ignore, empty by default

**Returns**: dict - A dict containing the results as a Series with unique words as index and the computed frequency as value

**Docstring**:
```
Count the number of occurrences of each individual word across
all lines of the data Series, then sort from the word with the most
occurrences to the word with the least occurrences. If a list of
stop words is given, they will be ignored.

Args:
    vc: Series containing all unique categories as index and their
        frequency as value. Sorted from the most frequent down.
    stop_words: List of stop words to ignore, empty by default.

Returns:
    A dict containing the results as a Series with unique words as
    index and the computed frequency as value
```

**Function**: Splits text into words, filters stop words, computes weighted word frequencies, and returns summary dictionary.

---

**Function length_summary_vc**

**Function**: Gets length summary using value_counts.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_categorical_pandas import length_summary_vc

def length_summary_vc(vc: pd.Series) -> dict: ...
```

**Parameters**:
- vc: pd.Series - Series with unique values as index and frequencies as values

**Returns**: dict - Dictionary with max_length, mean_length, median_length, and min_length statistics

**Function**: Creates series from vc.index, computes string lengths using str.len(). Groups length counts by length value and sums frequencies. Computes max_length (np.max), mean_length (weighted average), median_length (weighted_median), and min_length (np.min) from length distribution.

---

**Datetime Functions**:

**Function to_datetime**

**Function**: Converts value to datetime with pandas version compatibility.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_date_pandas import to_datetime

def to_datetime(series: pd.Series) -> pd.Series: ...
```

**Parameters**:
- series: pd.Series - Series to convert to datetime

**Returns**: pd.Series - Converted datetime series

**Function**: Checks pandas version using is_pandas_1(). For pandas 1.x, uses pd.to_datetime with errors="coerce". For pandas 2.x+, uses pd.to_datetime with format="mixed" and errors="coerce".

---

**Function convert_datetime**

**Function**: It is an internal function of the file_summary function, Converts datetime timestamp to formatted string.

**Signature**:
```python
# Internal function within describe_file_1d in describe_file_pandas.py

def convert_datetime(x: float) -> str: ...
```

**Parameters**:
- x: float - Unix timestamp

**Returns**: str - Formatted datetime string "YYYY-MM-DD HH:MM:SS"

**Function**: Converts Unix timestamp to datetime using datetime.fromtimestamp(x) and formats as string with strftime("%Y-%m-%d %H:%M:%S").

---

**File Path Functions** (from `ydata_profiling.model.pandas.describe_file_pandas` and `ydata_profiling.model.pandas.describe_path_pandas`):

**Function file_summary**

**Function**: Generates file path summary statistics including file size and timestamps.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_file_pandas import file_summary

def file_summary(series: pd.Series) -> dict: ...
```

**Parameters**:
- series: pd.Series - series to summarize

**Returns**: dict - Dictionary with file_size, file_created_time, file_accessed_time, file_modified_time

---

**Image Processing Functions** (from `ydata_profiling.model.pandas.describe_image_pandas`):

**Function open_image**

**Function**: Opens an image file for processing.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import open_image

def open_image(path: Path) -> Optional[Image.Image]: ...
```

**Parameters**:
- path: Path - Path to the image file

**Returns**: Optional[Image.Image] - PIL Image object or None if opening failed

---

**Function is_image_truncated**

**Function**: Returns True if the image is truncated.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import is_image_truncated

def is_image_truncated(image: Image) -> bool: ...
```

**Parameters**:
- image: Image - PIL Image object

**Returns**: bool - True if the image is truncated

**Docstring**: "Returns True if the path refers to a truncated image"

---

**Function get_image_shape**

**Function**: Gets dimensions (width, height) of an image.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import get_image_shape

def get_image_shape(image: Image) -> Optional[Tuple[int, int]]: ...
```

**Parameters**:
- image: Image - PIL Image object

**Returns**: Optional[Tuple[int, int]] - Image dimensions or None

---

**Function hash_image**

**Function**: Computes perceptual hash of an image for duplicate detection.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import hash_image

def hash_image(image: Image) -> Optional[str]: ...
```

**Parameters**:
- image: Image - PIL Image object

**Returns**: Optional[str] - Image hash string or None

---

**Function decode_byte_exif**

**Function**: Decodes byte-encoded EXIF values to strings.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import decode_byte_exif

def decode_byte_exif(exif_val: Union[str, bytes]) -> str: ...
```

**Parameters**:
- exif_val: Union[str, bytes] - EXIF value to decode

**Returns**: str - Decoded string

**Docstring**: "Decode byte encodings"

---

**Function extract_exif**

**Function**: Extracts EXIF metadata from an image.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import extract_exif

def extract_exif(image: Image) -> dict: ...
```

**Parameters**:
- image: Image - PIL Image object

**Returns**: dict - Dictionary of EXIF metadata

---

**Function path_is_image**

**Function**: Tests if a path points to an image file based on MIME type.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import path_is_image

def path_is_image(p: Path) -> bool: ...
```

**Parameters**:
- p: Path - Path to test

**Returns**: bool - True if path is an image file

---

**Function count_duplicate_hashes**

**Function**: Counts duplicate image hashes in a collection of image descriptions.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import count_duplicate_hashes

def count_duplicate_hashes(image_descriptions: dict) -> int: ...
```

**Parameters**:
- image_descriptions: dict - Dictionary of image descriptions with hashes

**Returns**: int - Number of duplicate hashes

---

**Function extract_exif_series**

**Function**: Extracts EXIF metadata from a series of images.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import extract_exif_series

def extract_exif_series(image_exifs: list) -> dict: ...
```

**Parameters**:
- image_exifs: list - List of EXIF dictionaries

**Returns**: dict - Dictionary with exif_keys counts and per-key value counts

---

**Function extract_image_information**

**Function**: Extracts comprehensive image information per file including size, EXIF, and hash.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import extract_image_information

def extract_image_information(
    path: Path, exif: bool = False, hash: bool = False
) -> dict: ...
```

**Parameters**:
- path: Path - Path to the image
- exif: bool - extract exif information (default False)
- hash: bool - calculate hash for duplicate detection (default False)

**Returns**: dict - Dictionary containing image information

**Docstring**: "Extracts all image information per file, as opening files is slow"

---

**Function image_summary**

**Function**: Generates comprehensive image summary statistics including dimensions, EXIF, and duplicates.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_image_pandas import image_summary

def image_summary(series: pd.Series, exif: bool = False, hash: bool = False) -> dict: ...
```

**Parameters**:
- series: pd.Series - series to summarize
- exif: bool - extract exif information (default False)
- hash: bool - calculate hash for duplicate detection (default False)

**Returns**: dict - Dictionary with image summary statistics

---
- **Function mad**: Computes median absolute deviation.

**Signature**:
```python
def mad(arr: np.ndarray) -> np.ndarray:
```

**Docstring**:
```
Median Absolute Deviation: a "Robust" version of standard deviation.
Indices variability of the sample.
https://en.wikipedia.org/wiki/Median_absolute_deviation
```

**Algorithm**:
```
1. Calculate median of array
2. Calculate absolute deviations from median: |arr - median(arr)|
3. Return median of absolute deviations
```

- **Function numeric_stats_pandas**: Computes numeric statistics using pandas.

**Signature**:
```python
def numeric_stats_pandas(series: pd.Series) -> Dict[str, Any]:
```

**Algorithm**:
```
Return dictionary with:
- mean: series.mean()
- std: series.std()
- variance: series.var()
- min: series.min()
- max: series.max()
- kurtosis: series.kurt() (Fisher's definition, normalized by N-1)
- skewness: series.skew() (normalized by N-1)
- sum: series.sum()
```

- **Function numeric_stats_numpy**: Computes numeric statistics using numpy.

**Signature**:
```python
def numeric_stats_numpy(
    present_values: np.ndarray, series: pd.Series, series_description: Dict[str, Any]
) -> Dict[str, Any]:
```

**Algorithm**:
```
1. Get value_counts_without_nan from series_description
2. Extract index_values from value_counts
3. If index_values not empty:
   - mean: weighted average using value counts
   - std: np.std(present_values, ddof=1)
   - variance: np.var(present_values, ddof=1)
   - min: np.min(index_values)
   - max: np.max(index_values)
   - kurtosis: series.kurt() (Fisher's definition)
   - skewness: series.skew()
   - sum: dot product of index_values and counts
4. If empty:
   - Return NaN/0 for all statistics
```
**Function path_summary**

**Function**: Generates path summary statistics including common prefix, stem, suffix, name, parent directory, and anchor counts.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_path_pandas import path_summary

def path_summary(series: pd.Series) -> dict: ...
```

**Parameters**:
- series: pd.Series - series to summarize

**Returns**: dict - Dictionary with path component statistics

---
- **Function stationarity_test**: Performs stationarity test on timeseries.

**Signature**:
```python
def stationarity_test(config: Settings, series: pd.Series) -> Tuple[bool, float]:
```

**Algorithm**:
```
1. Drop missing values from series
2. Perform Augmented Dickey-Fuller test using statsmodels.adfuller:
   - autolag: config.vars.timeseries.autolag (e.g., "AIC")
   - maxlag: config.vars.timeseries.maxlag
3. Extract p-value from ADF test result
4. Compare p-value with significance threshold (default: 0.05)
5. Return (is_stationary, p_value) where:
   - is_stationary = True if p_value < threshold
```

- **Function fftfreq**: Computes FFT frequencies.

**Signature**:
```python
def fftfreq(n: int, d: float = 1.0) -> np.ndarray:
```

**Docstring**:
```
Return the Discrete Fourier Transform sample frequencies.

Args:
    n : int
        Window length.
    d : scalar, optional
        Sample spacing (inverse of the sampling rate). Defaults to 1.

Returns:
    f : ndarray
        Array of length `n` containing the sample frequencies.
```

**Algorithm**:
```
1. Calculate frequency spacing: val = 1.0 / (n * d)
2. Create empty array of length n
3. Calculate positive frequencies:
   - N = (n - 1) // 2 + 1
   - results[:N] = [0, 1, 2, ..., N-1] * val
4. Calculate negative frequencies:
   - results[N:] = [-(n//2), ..., -1] * val
5. Return frequency array
```

- **Function seasonality_test**: Tests for seasonality in timeseries.

**Signature**:
```python
def seasonality_test(series: pd.Series, mad_threshold: float = 6.0) -> Dict[str, Any]:
```

**Docstring**:
```
Detect seasonality with FFT

Source: https://github.com/facebookresearch/Kats/blob/main/kats/detectors/seasonality.py

Args:
    mad_threshold: Optional; float; constant for the outlier algorithm for peak
        detector. The larger the value the less sensitive the outlier algorithm
        is.

Returns:
    FFT Plot with peaks, selected peaks, and outlier boundary line.
```

**Algorithm**:
```
1. Compute FFT using get_fft(series)
2. Identify peaks using get_fft_peaks(fft, mad_threshold)
3. Check seasonality presence: True if peaks exist
4. If seasonality present:
   - Convert peak frequencies to periods: period = 1 / frequency
   - Store as selected_seasonalities list
5. Return {
     "seasonality_presence": bool,
     "seasonalities": List[float] (periods)
   }
```

- **Function get_fft**: Computes Fast Fourier Transform.

**Signature**:
```python
def get_fft(series: pd.Series) -> pd.DataFrame:
```

**Docstring**:
```
Computes FFT

Args:
    series: pd.Series
        time series

Returns:
    DataFrame with columns 'freq' and 'ampl'.
```

**Algorithm**:
```
1. Compute FFT using scipy.fft.fft(series.to_numpy())
2. Calculate power spectral density: PSD = |FFT|²
3. Compute frequency bins using fftfreq(len(PSD), 1.0)
4. Select positive frequencies only (freq > 0)
5. Convert amplitude to decibels: ampl = 10 * log10(PSD)
6. Return DataFrame with 'freq' and 'ampl' columns
```

- **Function get_fft_peaks**: Identifies peaks in FFT.

**Signature**:
```python
def get_fft_peaks(
    fft: pd.DataFrame, mad_threshold: float = 6.0
) -> Tuple[float, pd.DataFrame, pd.DataFrame]:
```

**Docstring**:
```
Computes peaks in fft, selects the highest peaks (outliers) and
    removes the harmonics (multiplies of the base harmonics found)

Args:
    fft: FFT computed by get_fft
    mad_threshold: Optional; constant for the outlier algorithm for peak detector.
        The larger the value the less sensitive the outlier algorithm is.

Returns:
    outlier threshold, peaks, selected peaks.
```

**Algorithm**:
```
1. Filter positive amplitudes: pos_fft = fft[ampl > 0]
2. Calculate median amplitude
3. Get amplitudes above median
4. Calculate MAD (mean absolute deviation from mean)
5. Set outlier threshold = median + MAD * mad_threshold
6. Find all peaks using scipy.signal.find_peaks
7. Filter peaks above threshold
8. Remove harmonic frequencies:
   - For each peak pair (freq1, freq2):
     - If freq2/freq1 is close to integer (fraction < 0.01 or > 0.99):
       - Mark freq2 for removal (it's a harmonic)
9. Return (threshold, all_peaks, filtered_peaks)
```
**Utility and Helper Functions**

These are miscellaneous utility functions used throughout the codebase:

**Timeseries Functions** (from `ydata_profiling.model.pandas.describe_timeseries_pandas`):

**Function identify_gaps**

**Function**: Identifies gaps in timeseries by detecting differences larger than tolerance threshold.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_timeseries_pandas import identify_gaps

def identify_gaps(
    gap: pd.Series, is_datetime: bool, gap_tolerance: int = 2
) -> Tuple[pd.Series, list]: ...
```

**Parameters**:
- gap: pd.Series - Time series index or values to analyze
- is_datetime: bool - Whether data is datetime type
- gap_tolerance: int - Tolerance multiplier for gap detection (default: 2)

**Returns**: Tuple[pd.Series, list] - (gap_stats series, list of gap ranges)

**Function**: Sets zero value (pd.Timedelta(0) for datetime, 0 otherwise). Computes differences using diff(). Filters non-zero differences and computes min_gap_size = gap_tolerance * mean(non_zero_diff). Identifies gaps where diff > min_gap_size. Returns gap statistics and list of gap anchor pairs.

---

**Function compute_gap_stats**

**Function**: Computes gap statistics for timeseries data.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_timeseries_pandas import compute_gap_stats

def compute_gap_stats(series: pd.Series) -> pd.Series: ...
```

**Parameters**:
- series: pd.Series - Time series data to analyze

**Returns**: pd.Series - Series with gap intervals

**Docstring**:
```
Computes the intertevals in the series normalized by the period.

Args:
    series (pd.Series): time series data to analysis.

Returns:
    A series with the gaps intervals.
```

**Function**: Drops NaN values from series. Resets index and extracts index column. Detects if series has DatetimeIndex. Calls identify_gaps to compute gap statistics.

---

**URL Functions** (from `ydata_profiling.model.pandas.describe_url_pandas`):

**Function url_summary**

**Function**: Generates URL summary statistics by parsing scheme, netloc, path, query, and fragment components.

**Signature**:
```python
from ydata_profiling.model.pandas.describe_url_pandas import url_summary

def url_summary(series: pd.Series) -> dict: ...
```

**Parameters**:
- series: pd.Series - Series of parsed URL objects to summarize

**Returns**: dict - Dictionary with scheme_counts, netloc_counts, path_counts, query_counts, fragment_counts

**Docstring**:
```

Args:
    series: series to summarize

Returns:

```

**Function**: Maps series to extract each URL component (scheme, netloc, path, query, fragment) and computes value_counts() for each. Returns dictionary with counts for all five components.

---

**Statistical Functions** (from various modules):

**Function column_imbalance_score**

**Function**: Computes imbalance score for a column based on value distribution.

**Signature**:
```python
from ydata_profiling.model.pandas.imbalance_pandas import column_imbalance_score

def column_imbalance_score(
    value_counts: pd.Series, n_classes: int
) -> Union[float, int]: ...
```

**Parameters**:
- value_counts: pd.Series - Frequency of each category
- n_classes: int - Number of classes

**Returns**: Union[float, int] - Float or integer bounded between 0 and 1 inclusively

**Docstring**:
```
column_imbalance_score

The class balance score for categorical and boolean variables uses entropy to calculate a  bounded score between 0 and 1.
A perfectly uniform distribution would return a score of 0, and a perfectly imbalanced distribution would return a score of 1.

When dealing with probabilities with finite values (e.g categorical), entropy is maximised the 'flatter' the distribution is. (Jaynes: Probability Theory, The Logic of Science)
To calculate the class imbalance, we calculate the entropy of that distribution and the maximum possible entropy for that number of classes.
To calculate the entropy of the 'distribution' we use value counts (e.g frequency of classes) and we can determine the maximum entropy as log2(number of classes).
We then divide the entropy by the maximum possible entropy to get a value between 0 and 1 which we then subtract from 1.

Args:
    value_counts (pd.Series): frequency of each category
    n_classes (int): number of classes

Returns:
    Union[float, int]: float or integer bounded between 0 and 1 inclusively
```

**Function**: Returns 0 if n_classes <= 1 (prevents zero division and handles single class as balanced). Otherwise converts value_counts to numpy array, computes entropy with base=2, divides by log2(n_classes) to normalize, and returns 1 - (normalized_entropy).

---

**Function weighted_median**

**Function**: Computes weighted median value from a series.

**Signature**:
```python
from ydata_profiling.model.pandas.utils_pandas import weighted_median

def weighted_median(data: np.ndarray, weights: np.ndarray) -> int: ...
```

**Parameters**:
- data: np.ndarray - Data array (list or numpy.array)
- weights: np.ndarray - Weights array (list or numpy.array)

**Returns**: int - Weighted median value

**Docstring**:
```
Args:
  data (list or numpy.array): data
  weights (list or numpy.array): weights
```

**Function**: Converts inputs to numpy arrays if needed. Sorts both data and weights. Computes midpoint = 0.5 * sum(weights). If largest weight > midpoint, returns value with max weight. Otherwise computes cumulative sum of weights, finds index where cumsum <= midpoint. If cumsum[idx] == midpoint, returns mean of s_data[idx:idx+2]. Otherwise returns s_data[idx+1].

---

**Spark Utility Functions** (from `ydata_profiling.model.spark`):

**Function date_stats_spark**

**Function**: Computes date statistics (min, max) in Spark DataFrames.

**Signature**:
```python
from ydata_profiling.model.spark.describe_date_spark import date_stats_spark

def date_stats_spark(df: DataFrame, summary: dict) -> dict: ...
```

**Parameters**:
- df: DataFrame - Spark DataFrame with single date column
- summary: dict - Dictionary with series description

**Returns**: dict - Dictionary with 'min' and 'max' date values

**Function**: Gets first column name. Creates aggregation expressions for F.min and F.max on the column. Aggregates using df.agg(*expr).first().asDict() and returns result.

---

**Function numeric_stats_spark**

**Function**: Computes numeric statistics (mean, std, variance, min, max, kurtosis, skewness, sum) in Spark DataFrames.

**Signature**:
```python
from ydata_profiling.model.spark.describe_numeric_spark import numeric_stats_spark

def numeric_stats_spark(df: DataFrame, summary: dict) -> dict: ...
```

**Parameters**:
- df: DataFrame - Spark DataFrame with single numeric column
- summary: dict - Dictionary with series description

**Returns**: dict - Dictionary with mean, std, variance, min, max, kurtosis, skewness, sum statistics

**Function**: Gets first column name. Creates aggregation expressions for F.mean, F.stddev, F.variance, F.min, F.max, F.kurtosis, F.skewness, F.sum on the column. Aggregates using df.agg(*expr).first().asDict() and returns result.

---

**Formatting and String Utilities** (from `ydata_profiling.report.formatters`):

**Function list_args**

**Function**: Decorator to extend function to allow taking a list as first argument and apply function on each element.

**Signature**:
```python
from ydata_profiling.report.formatters import list_args

def list_args(func: Callable) -> Callable: ...
```

**Parameters**:
- func: Callable - The function to extend

**Returns**: Callable - The extended function

**Docstring**:
```
Extend the function to allow taking a list as the first argument, and apply the function on each of the elements.

Args:
    func: the function to extend

Returns:
    The extended function
```

**Function**: Returns inner function that checks if first argument is list. If list, applies func to each element. Otherwise applies func normally.

---

**Function round_number**

**Function**: Rounds number to specified precision for display (internal function within fmt_timespan).

**Signature**:
```python
# Internal function within fmt_timespan in formatters.py

def round_number(count: Any, keep_width: bool = False) -> str: ...
```

**Parameters**:
- count: Any - Number to round
- keep_width: bool - Whether to keep trailing zeros (default: False)

**Returns**: str - Formatted number string

**Function**: Formats count as "{float:.2f}". If not keep_width, removes trailing zeros with regex and removes trailing decimal point.

---

**Function coerce_seconds**

**Function**: Coerces time value to seconds (internal function within fmt_timespan).

**Signature**:
```python
# Internal function within fmt_timespan in formatters.py

def coerce_seconds(value: Union[timedelta, int, float]) -> float: ...
```

**Parameters**:
- value: Union[timedelta, int, float] - Time value to convert

**Returns**: float - Value in seconds

**Function**: If value is timedelta, returns value.total_seconds(). Otherwise returns float(value).

---

**Function concatenate**

**Function**: Concatenates strings with "and" separator (internal function within fmt_timespan).

**Signature**:
```python
# Internal function within fmt_timespan in formatters.py

def concatenate(items: List[str]) -> str: ...
```

**Parameters**:
- items: List[str] - List of strings to concatenate

**Returns**: str - Concatenated string

**Function**: Converts to list. If len > 1, joins all but last with ", " and adds " and " + last item. If single item, returns it. If empty, returns empty string.

---

**Function pluralize**

**Function**: Pluralizes word based on count (internal function within fmt_timespan).

**Signature**:
```python
# Internal function within fmt_timespan in formatters.py

def pluralize(count: Any, singular: str, plural: Optional[str] = None) -> str: ...
```

**Parameters**:
- count: Any - Count value
- singular: str - Singular form of word
- plural: Optional[str] - Plural form (default: singular + "s")

**Returns**: str - Formatted string with count and word

**Function**: If plural not provided, uses singular + "s". Returns "{count} {singular}" if floor(float(count)) == 1, otherwise "{count} {plural}".

---

**Function remove_suffix**

**Function**: Removes suffix from string (backport for older Python versions).

**Signature**:
```python
from ydata_profiling.report.formatters import remove_suffix

def remove_suffix(text: str, suffix: str) -> str: ...
```

**Parameters**:
- text: str - String to process
- suffix: str - Suffix to remove

**Returns**: str - String with suffix removed if present

**Function**: Backport of Python 3.9's str.removesuffix() for compatibility with older Python versions.

---

**Display and Visualization Utilities**:

**Function format_fn**

**Function**: Generic formatting function for timestamp values.

**Signature**:
```python
from ydata_profiling.visualisation.plot import format_fn

def format_fn(tick_val: int, tick_pos: Any) -> str: ...
```

**Parameters**:
- tick_val: int - Timestamp tick value
- tick_pos: Any - Tick position (unused)

**Returns**: str - Formatted datetime string

**Function**: Converts tick_val timestamp to datetime using convert_timestamp_to_datetime and formats as "%Y-%m-%d %H:%M:%S".

---

**Function make_autopct**

**Function**: Creates autopct function for pie chart percentage labels (internal function within _plot_pie_chart).

**Signature**:
```python
# Internal function within _plot_pie_chart in plot.py

def make_autopct(values: pd.Series) -> Callable: ...
```

**Parameters**:
- values: pd.Series - Data values for pie chart

**Returns**: Callable - Autopct formatter function

**Function**: Returns my_autopct closure that formats percentage as "{pct:.1f}% ({val:d})" where val = int(round(pct * total / 100)).

---

**Function my_autopct**

**Function**: Custom autopct formatter for pie charts (internal function within make_autopct).

**Signature**:
```python
# Internal function within make_autopct in plot.py

def my_autopct(pct: float) -> str: ...
```

**Parameters**:
- pct: float - Percentage value

**Returns**: str - Formatted string

**Function**: Computes total from outer scope values. Calculates val = int(round(pct * total / 100)). Returns f"{pct:.1f}% ({val:d})".

---

**Function create_comparison_color_list**

**Function**: Creates color list for comparison plots.

**Signature**:
```python
from ydata_profiling.visualisation.plot import create_comparison_color_list

def create_comparison_color_list(config: Settings) -> List[str]: ...
```

**Parameters**:
- config: Settings - Configuration with colors and labels

**Returns**: List[str] - List of hex color codes

**Function**: Gets colors and labels from config. If colors < labels (len comparison), creates color gradient using LinearSegmentedColormap from first color (or first two colors if available) spanning len(labels) values. Returns list of hex color codes.

---

**Function get_cmap_half**

**Function**: Gets half of a colormap for visualization.

**Signature**:
```python
from ydata_profiling.visualisation.plot import get_cmap_half

def get_cmap_half(
    cmap: Union[Colormap, LinearSegmentedColormap, ListedColormap]
) -> LinearSegmentedColormap: ...
```

**Parameters**:
- cmap: Union[Colormap, LinearSegmentedColormap, ListedColormap] - The color map

**Returns**: LinearSegmentedColormap - A new color map based on the upper half

**Docstring**:
```
Get the upper half of the color map

Args:
    cmap: the color map

Returns:
    A new color map based on the upper half of another color map

References:
    https://stackoverflow.com/a/24746399/470433
```

**Function**: Evaluates existing colormap from 0.5 (midpoint) to 1 (upper end) with cmap.N // 2 samples. Creates new LinearSegmentedColormap from those colors.

---

**Function get_correlation_font_size**

**Function**: Calculates appropriate font size for correlation matrix based on size.

**Signature**:
```python
from ydata_profiling.visualisation.plot import get_correlation_font_size

def get_correlation_font_size(n_labels: int) -> Optional[int]: ...
```

**Parameters**:
- n_labels: int - The number of labels

**Returns**: Optional[int] - A font size or None for the default font size

**Docstring**:
```
Dynamic label font sizes in correlation plots

Args:
    n_labels: the number of labels

Returns:
    A font size or None for the default font size
```

**Function**: Returns 4 if n_labels > 100, 5 if > 80, 6 if > 50, 8 if > 40, otherwise None for default.

---
- **Function create_html_assets**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.html.templates import create_html_assets`

  **Signature**:
  ```python
  def create_html_assets(config: Settings, output_file: Path) -> None:
  ```

  **Parameters**:
  - `config`: Active `Settings` object providing HTML styling, asset prefix, and theme flags.
  - `output_file`: Destination `Path` used to derive the assets directory (`config.html.assets_prefix`).

  **Returns**: `None`. Rebuilds the HTML asset folder, rendering CSS/JS files through the shared `template()` helper.
- **Function get_name**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.container import get_name`

  **Signature**:
  ```python
  def get_name(item: Renderable) -> str:
  ```

  **Parameters**:
  - `item`: `Renderable` component rendered in notebook/widget flavour containers.

  **Returns**: Preferred label for the rendered item, using `item.name` when present and falling back to `item.anchor_id`.

  **Description**: Centralised helper to provide stable labels for tab, accordion, and grid widgets.

- **Function get_tabs**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.container import get_tabs`

  **Signature**:
  ```python
  def get_tabs(items: List[Renderable]) -> widgets.Tab:
  ```

  **Parameters**:
  - `items`: Sequence of `Renderable` components whose rendered children populate tab panes.

  **Returns**: `ipywidgets.Tab` instance with children set to each item’s `render()` output and titles set via `get_name`.

  **Description**: Builds tabbed navigation for widget-based reports, iterating through renderables to attach both content and labels.

- **Function get_list**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.container import get_list`

  **Signature**:
  ```python
  def get_list(items: List[Renderable]) -> widgets.VBox:
  ```

  **Parameters**:
  - `items`: Renderables to display in a vertical stack.

  **Returns**: `widgets.VBox` containing each item’s rendered widget.

  **Description**: Produces a simple vertical layout for notebook widgets, calling `render()` on every element.

- **Function get_named_list**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.container import get_named_list`

  **Signature**:
  ```python
  def get_named_list(items: List[Renderable]) -> widgets.VBox:
  ```

  **Parameters**:
  - `items`: Renderables requiring per-item headers.

  **Returns**: `widgets.VBox` whose rows combine a bold HTML title (`get_name(item)`) with each item’s rendered widget.

  **Description**: Wraps each renderable with a heading block so notebook viewers see labelled sections.

- **Function get_row**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.container import get_row`

  **Signature**:
  ```python
  def get_row(items: List[Renderable]) -> widgets.GridBox:
  ```

  **Parameters**:
  - `items`: Renderables arranged in a responsive row.

  **Returns**: `widgets.GridBox` whose layout adapts to 1–4 columns (100%, 50/50, 25/25/50, or 25% quartiles).

  **Description**: Applies preset CSS grid templates based on the number of items; raises `ValueError` when the column count exceeds four to guard against unsupported layouts.

- **Function get_batch_grid**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.container import get_batch_grid`

  **Signature**:
  ```python
  def get_batch_grid(
      items: List[Renderable], batch_size: int, titles: bool, subtitles: bool
  ) -> widgets.GridBox:
  ```

  **Parameters**:
  - `items`: Renderables to display in a grid grouping.
  - `batch_size`: Number of columns in the grid; each column width becomes `100 / batch_size`.
  - `titles`: When `True`, wraps each item with an `<h4>` heading containing `item.name`.
  - `subtitles`: When `True`, wraps each item with italic `<h5>` subtitle instead of the main title.

  **Returns**: `widgets.GridBox` populated with either raw rendered widgets or title/subtitle wrappers depending on the flags.

  **Description**: Provides batched grid arrangements for widget reports, supporting optional titles or subtitles to improve readability.

- **Function get_accordion**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.container import get_accordion`

  **Signature**:
  ```python
  def get_accordion(items: List[Renderable]) -> widgets.Accordion:
  ```

  **Parameters**:
  - `items`: Renderables to nest inside collapsible accordion panels.

  **Returns**: `widgets.Accordion` where each child is an item’s rendered widget and each panel title comes from `get_name`.

  **Description**: Produces an accordion widget for sectioned notebook content, ensuring titles match the underlying renderables.

- **Function frequency_table_nb**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.frequency_table_small import frequency_table_nb`

  **Signature**:
  ```python
  def frequency_table_nb(rows: List[List[dict]]) -> widgets.VBox:
  ```

  **Parameters**:
  - `rows`: Nested list of frequency table dictionaries (first sub-list contains the row descriptors).

  **Returns**: `widgets.VBox` composed of `widgets.HBox` rows with `FloatProgress` bars and count labels, styled per `extra_class`.

  **Description**: Renders notebook-friendly frequency tables, highlighting “missing” entries in red, “other” in blue, and standard rows with default progress styling.

- **Function get_notebook_iframe_srcdoc**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.notebook import get_notebook_iframe_srcdoc`

  **Signature**:
  ```python
  def get_notebook_iframe_srcdoc(config: Settings, profile: ProfileReport) -> "HTML":
  ```

  **Docstring**:
  ```
  """Get the IPython HTML object with iframe with the srcdoc attribute

  Args:
      config: Settings
      profile: The profile report object

  Returns:
      IPython HTML object.
  """
  ```

- **Function get_notebook_iframe_src**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.notebook import get_notebook_iframe_src`

  **Signature**:
  ```python
  def get_notebook_iframe_src(config: Settings, profile: ProfileReport) -> "IFrame":
  ```

  **Docstring**:
  ```
  """Get the IPython IFrame object

  Args:
      config: Settings
      profile: The profile report object

  Returns:
      IPython IFrame object.
  """
  ```

- **Function get_notebook_iframe**

  **Import Method**: `from ydata_profiling.report.presentation.flavours.widget.notebook import get_notebook_iframe`

  **Signature**:
  ```python
  def get_notebook_iframe(
      config: Settings, profile: ProfileReport
  ) -> Union["IFrame", "HTML"]:
  ```

  **Docstring**:
  ```
  """Display the profile report in an iframe in the Jupyter notebook

  Args:
      config: Settings
      profile: The profile report object

  Returns:
      Displays the Iframe
  """
  ```

- **Function fmt_version**

  **Defined In**: Nested inside `ydata_profiling.report.structure.overview.get_dataset_reproduction`

  **Decorators**: `@list_args`

  **Signature**:
  ```python
  @list_args
  def fmt_version(version: str) -> str:
  ```

  **Returns**: Hyperlink string pointing to the ydata-profiling repository with the current version label.

  **Description**: Formats software version metadata for the reproduction table, preserving support for both scalar values and lists through `list_args`.

- **Function fmt_config**

  **Defined In**: Nested inside `ydata_profiling.report.structure.overview.get_dataset_reproduction`

  **Decorators**: `@list_args`

  **Signature**:
  ```python
  @list_args
  def fmt_config(config: str) -> str:
  ```

  **Returns**: Download-friendly anchor tag (`config.json`) embedding the configuration JSON via `data:` URL encoding.

  **Description**: Supplies the reproduction section with a direct configuration export link.

- **Function fmt_tsindex_limit**

  **Defined In**: `ydata_profiling.report.structure.overview.get_time_series_analysis`

  **Signature**:
  ```python
  def fmt_tsindex_limit(limit: Any) -> str:
  ```

  **Parameters**:
  - `limit`: Either a `datetime` bound or numeric limit taken from `TimeIndexAnalysis`.

  **Returns**: Human-readable timestamp (`YYYY-MM-DD HH:MM:SS`) when `limit` is a `datetime`, otherwise delegates to `fmt_number` for numeric rendering.

  **Description**: Normalises boundary values shown in the time-series overview statistics.

- **Function inner**

  **Defined In**: Nested inside `ydata_profiling.report.formatters.list_args`

  **Signature**:
  ```python
  def inner(arg: Any, *args: Any, **kwargs: Any) -> Any:
  ```

  **Parameters**:
  - `arg`: Primary argument passed to the decorated formatter; may be a single value or list.
  - `*args`, `**kwargs`: Additional positional and keyword arguments forwarded to the wrapped function.

  **Returns**: Applies the wrapped formatter to each element when `arg` is a list; otherwise returns the direct call result.

  **Description**: Shared adapter enabling formatter helpers to accept either scalar values or lists seamlessly.

- **Function optional_option_context**

  **Import Method**: `from ydata_profiling.utils.compat import optional_option_context`

  **Signature**:
  ```python
  def optional_option_context(
      option_key: str, value: object
  ) -> Generator[None, None, None]:
  ```

  **Docstring**:
  ```
  """
  A context manager that sets an option only if it is available in the
  current pandas version; otherwise, it is a no-op.
  """
  ```

### Report Generation and Rendering Module

#### Formatting Tools

**Module Docstring**: `"""Formatters are mappings from object(s) to a string."""`

**Decorator list_args**

**Signature**:
```python
def list_args(func: Callable) -> Callable
```

**Docstring**:
```
Extend the function to allow taking a list as the first argument, and apply the function on each of the elements.

Args:
    func: the function to extend

Returns:
    The extended function
```

**Note**: Most formatting functions below use the `@list_args` decorator, which allows them to accept either a single value or a list of values.

**Function fmt_color**

**Import Method**: `from ydata_profiling.report.formatters import fmt_color`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_color(text: str, color: str) -> str
```

**Docstring**:
```
Format a string in a certain color (`<span>`).

Args:
  text: The text to format.
  color: Any valid CSS color.

Returns:
    A `<span>` that contains the colored text.
```

**Function fmt_class**

**Import Method**: `from ydata_profiling.report.formatters import fmt_class`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_class(text: str, cls: str) -> str
```

**Docstring**:
```
Format a string in a certain class (`<span>`).

Args:
  text: The text to format.
  cls: The name of the class.

Returns:
    A `<span>` with a class added.
```

**Function fmt_bytesize**

**Import Method**: `from ydata_profiling.report.formatters import fmt_bytesize`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_bytesize(num: float, suffix: str = "B") -> str
```

**Docstring**:
```
Change a number of bytes in a human-readable format.

Args:
  num: number to format
  suffix: (Default value = 'B')

Returns:
  The value formatted in human readable format (e.g. KiB).
```

**Function fmt_percent**

**Import Method**: `from ydata_profiling.report.formatters import fmt_percent`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_percent(value: float, edge_cases: bool = True) -> str
```

**Docstring**:
```
Format a ratio as a percentage.

Args:
    edge_cases: Check for edge cases?
    value: The ratio.

Returns:
    The percentage with 1 point precision.
```

**Function fmt_timespan**

**Import Method**: `from ydata_profiling.report.formatters import fmt_timespan`

**Decorator**: `@list_args`

**Signature**:
```python
@list_args
def fmt_timespan(num_seconds: Any, detailed: bool = False, max_units: int = 3) -> str
```

**Function**: Formats timespan values for display. Converts seconds to human-readable format (nanoseconds to weeks). Adapted from the `humanfriendly` module.

**Function fmt_numeric**

**Import Method**: `from ydata_profiling.report.formatters import fmt_numeric`

**Decorator**: `@list_args`

**Signature**:
```python
def fmt_numeric(value: float, precision: int = 10) -> str
```

**Docstring**:
```
Format any numeric value.

Args:
    value: The numeric value to format.
    precision: The numeric precision

Returns:
    The numeric value with the given precision.
```

**Function**: Formats numeric values with specified precision. Converts scientific notation (e+, e-) to HTML superscript format (× 10<sup>n</sup>).

**Function fmt_number**

**Import Method**: `from ydata_profiling.report.formatters import fmt_number`

**Decorator**: `@list_args`

**Signature**:
```python
def fmt_number(value: int) -> str
```

**Docstring**:
```
Format any numeric value.

Args:
    value: The numeric value to format.

Returns:
    The numeric value with the given precision.
```

**Function**: Formats integer values using locale-aware formatting (uses Python's `:n` format specifier).

**Function fmt_array**

**Import Method**: `from ydata_profiling.report.formatters import fmt_array`

**Decorator**: `@list_args`

**Signature**:
```python
def fmt_array(value: np.ndarray, threshold: Any = np.nan) -> str
```

**Docstring**:
```
Format numpy arrays.

Args:
    value: Array to format.
    threshold: Threshold at which to show ellipsis

Returns:
    The string representation of the numpy array.
```

**Function**: Formats numpy arrays with controlled output length. Uses `np.printoptions` to limit display to 3 elements with ellipsis for large arrays.

**Function fmt_monotonic**

**Function**: Formats monotonicity value (-2 to 2) into descriptive text.

**Signature**:
```python
from ydata_profiling.report.formatters import fmt_monotonic

def fmt_monotonic(value: int) -> str: ...
```

**Parameters**:
- value: int - Monotonicity value (-2, -1, 0, 1, or 2)

**Returns**: str - Formatted monotonicity description:
- -2: "Strictly decreasing"
- -1: "Decreasing"
- 0: "Not monotonic"
- 1: "Increasing"
- 2: "Strictly increasing"

**Raises**:
- ValueError: If value is not in range -2 to 2

---

#### Report Components

**Class CorrelationTable**

**Import Method**: `from ydata_profiling.report.presentation.core import CorrelationTable`
**Function**: Generates a correlation matrix table component.

**Class Image**

**Import Method**: `from ydata_profiling.report.presentation.core import Image`
**Function**: Handles the rendering of image components.

**Function get_correlation_items**

**Import Method**: `from ydata_profiling.report.structure.correlations import get_correlation_items`
**Function**: Gets correlation analysis items.

#### HTML Rendering

**Class HTMLHTML**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.html import HTMLHTML`

**Signature**:
```python
class HTMLHTML(HTML):
    def render(self) -> str:
```

**Function**: Returns the raw HTML string stored under `self.content["html"]` without additional templating.

**Function template**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.templates import template, create_html_assets`

**Signature**:
```python
def template(template_name: str) -> jinja2.Template:
```

**Docstring** (from source code):
```
Get the template object given the name.

Args:
  template_name: The name of the template file (.html)

Returns:
  The jinja2 environment.

```

**Parameters**:
- `template_name: str` - Name of the template file (.html) located inside `report/presentation/flavours/html/templates`.

**Returns**: A `jinja2.Template` instance loaded from the shared environment `jinja2_env`.

**Description**: Loads HTML template files via `jinja2.PackageLoader`, exposing them for all HTML renderers. The function uses `jinja2_env.get_template(template_name)` to retrieve the template.

**Note**: The source code's docstring states "Returns: The jinja2 environment" but actually returns a jinja2.Template object, not the environment itself.

**Class HTMLFrequencyTable**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.frequency_table import HTMLFrequencyTable`

**Signature**:
```python
class HTMLFrequencyTable(FrequencyTable):
    def render(self) -> str:
```

**Function**: Renders frequency tables, concatenating multiple template instances when `self.content["rows"]` contains batched lists.

**Class HTMLImage**

**Import Method**: `from ydata_profiling.report.presentation.flavours.html.image import HTMLImage`

**Signature**:
```python
class HTMLImage(Image):
    def render(self) -> str:
```

**Function**: Uses `diagram.html` to render plots and images with optional captions and alternate text.

### Visualization Module

**Module Docstring**: `"""Plot functions for the profiling report."""`

#### Main Plotting Functions

**Function histogram**

**Import Method**: `from ydata_profiling.visualisation.plot import histogram`

**Decorator**: `@manage_matplotlib_context()`

**Signature**:
```python
@manage_matplotlib_context()
def histogram(
    config: Settings,
    series: np.ndarray,
    bins: Union[int, np.ndarray],
    date: bool = False,
) -> str
```

**Docstring**:
```
Plot an histogram of the data.

Args:
    config: Settings
    series: The data to plot.
    bins: number of bins (int for equal size, ndarray for variable size)
    date: is histogram of date(time)?

Returns:
  The resulting histogram encoded as a string.
```

**Function**: Generates a histogram plot with automatic figure sizing (7x3), handles date formatting, and returns the plot as a base64-encoded string.

**Function mini_histogram**

**Import Method**: `from ydata_profiling.visualisation.plot import mini_histogram`

**Decorator**: `@manage_matplotlib_context()`

**Signature**:
```python
@manage_matplotlib_context()
def mini_histogram(
    config: Settings,
    series: np.ndarray,
    bins: Union[int, np.ndarray],
    date: bool = False,
) -> str
```

**Docstring**:
```
Plot a small (mini) histogram of the data.

Args:
  config: Settings
  series: The data to plot.
  bins: number of bins (int for equal size, ndarray for variable size)

Returns:
  The resulting mini histogram encoded as a string.
```

**Function**: Generates a smaller histogram plot (3x2.25) with hidden y-axis and smaller font sizes, suitable for inline display in reports.

**Function _plot_histogram**

**Import Method**: `from ydata_profiling.visualisation.plot import _plot_histogram`

**Signature**:
```python
def _plot_histogram(
    config: Settings,
    series: np.ndarray,
    bins: Union[int, np.ndarray],
    figsize: tuple = (6, 4),
    date: bool = False,
    hide_yaxis: bool = False,
) -> plt.Figure
```

**Docstring**:
```
Plot a histogram from the data and return the AxesSubplot object.

Args:
    config: the Settings object
    series: The data to plot
    bins: number of bins (int for equal size, ndarray for variable size)
    figsize: The size of the figure (width, height) in inches, default (6,4)
    date: is the x-axis of date type

Returns:
    The histogram plot.
```

**Function**: Internal function that creates the actual histogram matplotlib figure. Supports comparison mode with multiple series using different colors.

**Function _plot_word_cloud**

**Import Method**: `from ydata_profiling.visualisation.plot import _plot_word_cloud`

**Signature**:
```python
def _plot_word_cloud(
    config: Settings,
    series: Union[pd.Series, List[pd.Series]],
    figsize: tuple = (6, 4),
) -> plt.Figure
```

**Function**: Creates word cloud visualizations from frequency data. Supports single or multiple word clouds in one figure. Uses WordCloud library with custom font path from config.

**Function fmt_timespan_timedelta**
**Function**: Formats a timedelta object into a human-readable string (e.g., "1 day, 2 hours, 30 minutes").
```python
@list_args
def fmt_timespan_timedelta(
    delta: Any, detailed: bool = False, max_units: int = 3, precision: int = 10
) -> str: ...
```
**Parameters**:
- delta: timedelta object or list of timedelta objects to format.
- detailed: bool, optional (default=False) - Whether to include detailed units (e.g., "1 day, 2 hours, 30 minutes").
- max_units: int, optional (default=3) - Maximum number of units to include in the output.
- precision: int, optional (default=10) - Number of decimal places to round the values.

**Returns**: str - Formatted time span string.

**Function render_count**
**Function**: Renders frequency tables, concatenating multiple template instances when `self.content["rows"]` contains batched lists.

```python
def render_count(config: Settings, summary: dict) -> dict: ...

```
**Parameters**:
- config: Settings - Configuration object containing settings for rendering.
- summary: dict - Dictionary containing frequency table data with keys "rows" and "total".

**Returns**: dict - Rendered frequency table data with concatenated rows.


#### Compatibility Tools

**Variable pandas_version_info**

**Import Method**: `from ydata_profiling.utils.compat import pandas_version_info`
**Function**: Stores pandas version information.
```python 
@lru_cache(maxsize=1)
def pandas_version_info() -> Tuple[int, ...]: ...

```
**Returns**: Tuple[int, ...] - Pandas version as a tuple of integers (e.g., (1, 2, 3) for version 1.2.3)

### Comparison Analysis Module

#### Multi-Dataset Comparison

**Function _compare_title**

**Import Method**: `from ydata_profiling.compare_reports import _compare_title`
**Function**: Generates the title of the dataset comparison report.

```python
def _compare_title(titles: List[str]) -> str: ...
```
**Returns**: str - Formatted title string for the comparison report.


### Practical Usage Modes

#### 1. Basic Usage

```python
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.read_csv('data.csv')
profile = ProfileReport(df, title="Data Analysis Report")
profile.to_file("report.html")
```

#### 2. pandas Extension Usage

```python
import pandas as pd
import ydata_profiling

df = pd.read_csv('data.csv')
profile = df.profile_report(title="Quick Analysis")
profile.to_file("report.html")
```

#### 3. Command-Line Usage

```sh
ydata_profiling --title "My Report" data.csv report.html
```

#### 4. Configuration File Usage

```python
profile = ProfileReport(df, config_file="config_default.yaml")
profile.to_file("report.html")
```

#### 5. Multi-Dataset Comparison

```python
from ydata_profiling import ProfileReport, compare

profile1 = ProfileReport(df1, title="Dataset 1")
profile2 = ProfileReport(df2, title="Dataset 2")
comparison = compare([profile1, profile2])
comparison.to_file("compare_report.html")
```

#### 6. Jupyter Notebook Usage

```python
profile.to_notebook_iframe()   # Directly embed HTML
profile.to_widgets()           # Interactive widgets
```

#### 7. Advanced Configuration and Customization

```python
from ydata_profiling import ProfileReport, Settings

custom_settings = Settings(title="Custom Report", pool_size=4, progress_bar=False)
profile = ProfileReport(df, config=custom_settings)
profile.to_file("custom_report.html")
```

## Functional Nodes and Test Interface Examples

### 1. Univariate Statistics and Unique Value Detection

**Function Description**: Counts the unique values, unique ratios, and distinct value ratios of data columns, supporting scenarios with missing values and duplicate values.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport

# Recommended: Use high-level API
df = pd.DataFrame({"values": [1, 2, 2, None]})
profile = ProfileReport(df, minimal=True)
desc = profile.get_description()

# Access variable statistics
var_desc = desc.variables["values"]
print(f"Is unique: {var_desc.get('is_unique', False)}")
print(f"Distinct count: {var_desc.get('n_distinct', 0)}")
print(f"Distinct ratio: {var_desc.get('p_distinct', 0):.3f}")
# Output: Is unique: False, Distinct count: 2, Distinct ratio: 0.667

# Alternative: Use lower-level API (requires proper initialization)
from ydata_profiling.model.summarizer import ProfilingSummarizer
from ydata_profiling.model.typeset import ProfilingTypeSet
from ydata_profiling.config import Settings

series = pd.Series([1, 2, 2, None])
config = Settings()
typeset = ProfilingTypeSet(config)
summarizer = ProfilingSummarizer(typeset)

# Note: describe_1d is an internal function, use ProfileReport for production code
from ydata_profiling.model.summary import describe_1d
desc = describe_1d(config, series, summarizer, typeset)
print(desc.get("is_unique", False), desc.get("p_unique", 0), desc.get("p_distinct", 0))
# Output: False 0.333... 0.667...
```

### 2. Correlation Analysis and Visualization

**Function Description**: Automatically calculates various correlations (Pearson, Spearman, Kendall, Phi_k, Cramér's V, etc.) and generates correlation matrices and visualizations.

**Input-Output Example**:

```python
import numpy as np
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.DataFrame({
    "num1": np.random.rand(100),
    "num2": np.random.rand(100),
    "cat": np.random.choice(["A", "B"], 100)
})
profile = ProfileReport(df, correlations={"pearson": {"calculate": True}})
html = profile.to_html()
# Output: The HTML report contains correlation matrices and correlation tables.
```

### 3. Duplicate Value Detection

**Function Description**: Detects and counts **exact duplicate** rows in the DataFrame and outputs the duplicate rows and their counts. **Note**: Only exact row duplicates are detected; near-duplicate or fuzzy matching is not currently implemented.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling.model.duplicates import get_duplicates
from ydata_profiling.config import Settings

df = pd.DataFrame({"a": [1, 2, 2, 1], "b": [3, 4, 4, 3]})
config = Settings()
metrics, duplicates = get_duplicates(config, df, list(df.columns))
print(metrics["n_duplicates"], metrics["p_duplicates"])
# Output: 2 0.5
print(duplicates)
# Output: Contains duplicate rows and the # duplicates column.
```

### 4. Time Series Analysis

**Function Description**: Automatically identifies time series columns, analyzes features such as autocorrelation, seasonality, and trends, and supports missing values and sorting.

**Input-Output Example**:

```python
import numpy as np
import pandas as pd
from ydata_profiling import ProfileReport

dates = pd.date_range(start="2023-01-01", periods=100, freq="D")
df = pd.DataFrame({"date": dates, "value": np.sin(np.arange(100))})
profile = ProfileReport(df, tsmode=True, sortby="date")
html = profile.to_html()
# Output: The HTML report contains time series analysis, trends, seasonality, autocorrelation, etc.
```

### 5. Report Export and Multi-Format Support

**Function Description**: Supports exporting analysis reports as HTML and JSON files, supporting various formats such as local resources, CDN, theme switching, SVG/PNG images, etc.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.DataFrame({"a": range(10), "b": range(10)})
profile = ProfileReport(df, minimal=True, html={"inline": False, "style": {"theme": "united"}})
profile.to_file("report.html")
# Output: Generates report.html and related resource directories.
```

### 6. Custom Sample Sampling

**Function Description**: Supports customizing sample data for the report, facilitating desensitized display or sample replacement in special scenarios.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.DataFrame({"test": [1, 2, 3, 4, 5]})
mock_data = pd.DataFrame({"make": ["A", "B"], "price": [100, 200]})
profile = ProfileReport(df, sample={"name": "Mock", "data": mock_data, "caption": "Synthetic sample"}, minimal=True)
sample = profile.get_description().sample[0]
print(sample.name, sample.caption)
# Output: Mock Synthetic sample
```

### 7. Sensitive Data Desensitization

**Function Description**: Automatically desensitizes sensitive fields such as text and categories in sensitive mode to prevent the leakage of sensitive information.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.DataFrame({"name": ["Alice", "Bob"]})
profile = ProfileReport(df, sensitive=True)
html = profile.to_html()
assert "Alice" not in html and "Bob" not in html
# Output: The HTML report does not contain the original sensitive values.
```

### 8. Variable Interaction Analysis

**Function Description**: Analyzes the interaction relationships between specified target variables and other variables and generates interaction visualizations.

**Input-Output Example**:

```python
import numpy as np
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.DataFrame(np.random.rand(10, 5), columns=[f"col{i}" for i in range(5)])
targets = ["col0", "col1"]
profile = ProfileReport(df, interactions={"continuous": True, "targets": targets})
desc = profile.get_description()
print(desc.scatter.keys())
# Output: Contains the interaction analysis results between target variables and other variables.
```

### 9. Multi-Dataset Comparison Analysis

**Function Description**: Automatically compares the structure and distribution of multiple datasets or reports and outputs a difference analysis report.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport, compare

df1 = pd.DataFrame({"a": range(10)})
df2 = pd.DataFrame({"a": range(10, 20)})
profile1 = ProfileReport(df1, title="Dataset 1")
profile2 = ProfileReport(df2, title="Dataset 2")
comparison = compare([profile1, profile2])
html = comparison.to_html()
# Output: The HTML report contains multi-dataset comparison analysis content.
```

### 10. Configuration and Environment Variable Override

**Function Description**: Supports flexible configuration of report parameters through multiple methods such as constructor parameters, shorthand, and environment variables, supporting dynamic modification and persistence.

**Input-Output Example**:

```python
from ydata_profiling import ProfileReport
import os

os.environ["PROFILE_TITLE"] = "Testing Title"
report = ProfileReport(pool_size=3)
assert report.config.title == "Testing Title"
report.config.pool_size = 1
assert report.config.pool_size == 1
```

### 11. Formatting and Rendering Tools

**Function Description**: Provides various formatting tools for numerical values, arrays, bytes, colors, monotonicity, etc., supporting the beautiful rendering of report content.

**Input-Output Example**:

```python
from ydata_profiling.report.formatters import fmt_numeric, fmt_bytesize, fmt_color

print(fmt_numeric(1e8, 3))  # Output: '1 × 10<sup>8</sup>'
print(fmt_bytesize(1024))   # Output: '1.0 KiB'
print(fmt_color("Warning", "red"))  # Output: '<span style="color:red">Warning</span>'
```

### 12. Great Expectations Integration and Automatic Generation

**Function Description**: Supports automatically converting data analysis reports into Great Expectations suites and supports GE-related API calls and assertions.

**Input-Output Example**:

```python
from ydata_profiling import ProfileReport

df = ...  # Any DataFrame
profile = ProfileReport(df)
# Generate a GE expectation suite (requires installing great_expectations)
suite = profile.to_expectation_suite(data_context=..., save_suite=True, build_data_docs=True)
```

### 13. Handling of Multi-Index and Index-Column Name Conflicts

**Function Description**: Automatically handles complex DataFrame structures such as multi-index, multi-level column names, and index-column name conflicts to ensure the robustness of report generation.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.DataFrame({"foo": [1, 2, 3]}, index=pd.Index([1, 2, 3], name="foo"))
profile = ProfileReport(df)
html = profile.to_html()
# Output: The report is generated normally without index-column name conflicts.
```

### 14. Output Format and __repr__ Interface

**Function Description**: Supports JSON export of report objects, an empty string for __repr__ (for easy display in Jupyter), and assertions of the output content structure.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.DataFrame({"col1": [1, 2], "col2": [3, 4]})
report = ProfileReport(df)
json_str = report.to_json()
print(repr(report))  # Output: ''
```

### 15. Visualization Plotting and Categorical Frequency Plots

**Function Description**: Supports various visualizations (pie charts, stacked bar charts, heatmaps, etc.). Categorical variable frequency plots can be customized in terms of type, color, maximum number of unique values, etc.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.DataFrame({"cat": ["A"]*5 + ["B"]*5})
profile = ProfileReport(df)
profile.config.plot.cat_freq.type = "pie"
profile.config.plot.cat_freq.colors = ["gold", "blue"]
html = profile.to_html()
# Output: The HTML report contains a pie chart with custom colors.
```

### 16. Report Formatting and HTML Component Rendering

**Function Description**: Supports the rendering and customization of various report components such as frequency tables, images, and HTML fragments.

**Input-Output Example**:

```python
from ydata_profiling.report.presentation.flavours.html.frequency_table import HTMLFrequencyTable

item = HTMLFrequencyTable(rows=[{"count": 10, "percentage": 1.0, "label": "Pizza", "width": 1.0}], redact=False)
html = item.render()
# Output: An HTML frequency table fragment.
```

### 17. Report Option and Parameter Override

**Function Description**: Supports dynamically overriding report options through parameters, configuration files, and APIs, and supports various visualization parameters such as categorical frequency plots, maximum unique values, colors, and types.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport

df = pd.DataFrame({"cat": ["A"]*10 + ["B"]*10})
profile = ProfileReport(df)
profile.config.plot.cat_freq.max_unique = 5
profile.config.plot.cat_freq.type = "bar"
html = profile.to_html()
# Output: When the number of unique values exceeds max_unique, the frequency plot is not displayed.
```

### 18. Handling of Boundary and Abnormal Situations

**Function Description**: Supports robust handling of boundary situations such as all missing values, all constants, extremely large/small data, mixed types, and abnormal inputs.

**Important Note**: Empty DataFrames are **not supported**. ProfileReport will raise a `ValueError` if provided with an empty DataFrame.

**Input-Output Example**:

```python
import pandas as pd
from ydata_profiling import ProfileReport

# Example 1: Handling empty DataFrame (will raise error)
try:
    df = pd.DataFrame()
    profile = ProfileReport(df)
except ValueError as e:
    print(f"Error: {e}")
    # Output: Error: DataFrame is empty. Please provide a non-empty DataFrame.

# Example 2: Handling DataFrame with all missing values (supported)
df = pd.DataFrame({"a": [None, None, None], "b": [None, None, None]})
profile = ProfileReport(df, title="Data with Missing Values")
html = profile.to_html()
# Output: A report showing missing value analysis
```

### 19. Custom Handler and Summarizer

**Function Description**: Demonstrates how to create custom summarizers by extending BaseSummarizer and how to customize statistical computation for specific data types.

**Use Cases**:
- Adding custom statistics for specific data types
- Implementing domain-specific data analysis
- Extending profiling capabilities with custom metrics

#### Example 1: Creating a Custom Summarizer

```python
import pandas as pd
from typing import Dict, List, Callable, Type
from visions import VisionsBaseType
from ydata_profiling.model.summarizer import BaseSummarizer
from ydata_profiling.config import Settings
from ydata_profiling import ProfileReport

# Define a custom summary function for numeric data
def custom_numeric_summary(config: Settings, series: pd.Series, summary: dict) -> dict:
    """Add custom statistics for numeric columns."""
    # Add custom metrics
    summary["custom_range"] = series.max() - series.min()
    summary["custom_cv"] = series.std() / series.mean() if series.mean() != 0 else None
    summary["custom_outlier_count"] = len(series[abs(series - series.mean()) > 3 * series.std()])
    return summary

# Create a custom summarizer
class CustomSummarizer(BaseSummarizer):
    """A custom summarizer with additional statistics."""

    def __init__(self, typeset, *args, **kwargs):
        # Define custom mapping of types to summary functions
        from ydata_profiling.model.pandas import (
            pandas_describe_counts,
            pandas_describe_numeric_1d,
        )

        # Create summary map with custom functions
        summary_map: Dict[str, List[Callable]] = {
            "Numeric": [
                pandas_describe_counts,
                pandas_describe_numeric_1d,
                custom_numeric_summary,  # Add our custom function
            ],
            # Add other type mappings as needed
        }

        super().__init__(summary_map, typeset, *args, **kwargs)

# Usage example
df = pd.DataFrame({
    "age": [25, 30, 35, 40, 45, 100],  # 100 is an outlier
    "salary": [50000, 60000, 70000, 80000, 90000, 200000],  # 200000 is an outlier
})

# Create custom typeset and summarizer
from ydata_profiling.model.typeset import ProfilingTypeSet

config = Settings()
typeset = ProfilingTypeSet(config)
custom_summarizer = CustomSummarizer(typeset)

# Create profile with custom summarizer
# Note: To use custom summarizer, you need to access lower-level API
from ydata_profiling.model.summary import describe

description = describe(config, df, custom_summarizer, typeset)

# Access custom statistics
print(description.variables["age"]["custom_range"])  # 75
print(description.variables["age"]["custom_cv"])  # Coefficient of variation
print(description.variables["age"]["custom_outlier_count"])  # 1 (the value 100)
```

#### Example 2: Extending Existing Summarizer

```python
import pandas as pd
from ydata_profiling.model.summarizer import ProfilingSummarizer
from ydata_profiling.config import Settings

# Extend the default ProfilingSummarizer
config = Settings()
from ydata_profiling.model.typeset import ProfilingTypeSet
typeset = ProfilingTypeSet(config)

summarizer = ProfilingSummarizer(typeset)

# Add custom function to existing type mapping
def add_custom_text_metric(config: Settings, series: pd.Series, summary: dict) -> dict:
    """Add custom metrics for text columns."""
    summary["avg_word_count"] = series.str.split().str.len().mean()
    summary["max_word_count"] = series.str.split().str.len().max()
    return summary

# Modify the summary map to include custom function
summarizer.summary_map["Text"].append(add_custom_text_metric)

# Now use the modified summarizer
df = pd.DataFrame({
    "description": [
        "Short text",
        "This is a longer text with more words",
        "Medium length text here",
    ]
})

from ydata_profiling.model.summary import describe
description = describe(config, df, summarizer, typeset)

# Access custom text metrics
print(description.variables["description"]["avg_word_count"])
print(description.variables["description"]["max_word_count"])
```

#### Example 3: Custom Handler for Specific Use Case

```python
import pandas as pd
from typing import Dict, List, Callable
from ydata_profiling.model.handler import Handler
from visions import VisionsTypeset

# Create a custom handler for data quality checks
def check_data_quality(config, series, summary):
    """Custom data quality checks."""
    summary["data_quality_score"] = 100 - (summary.get("p_missing", 0) * 100)
    summary["is_high_quality"] = summary["data_quality_score"] >= 90
    return summary

# Create custom mapping
custom_mapping: Dict[str, List[Callable]] = {
    "Numeric": [check_data_quality],
    "Categorical": [check_data_quality],
    "Text": [check_data_quality],
}

# Initialize typeset
from ydata_profiling.model.typeset import ProfilingTypeSet
config = Settings()
typeset = ProfilingTypeSet(config)

# Create custom handler
handler = Handler(custom_mapping, typeset)

# Use handler directly
from visions import Integer
result = handler.handle(
    str(Integer),
    config,
    pd.Series([1, 2, 3, None]),
    {"type": str(Integer), "p_missing": 0.25}
)

print(result["data_quality_score"])  # 75.0
print(result["is_high_quality"])  # False
```

**Key Points**:
- `BaseSummarizer` extends `Handler` to provide summarization capabilities
- Custom functions receive `(config, series, summary)` and return updated `summary` dict
- Functions are composed and applied in sequence for each data type
- `ProfilingSummarizer.summary_map` property allows runtime modification
- Use the `describe()` function directly to leverage custom summarizers

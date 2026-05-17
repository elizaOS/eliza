# Constants - Task Instance Installation Environment
FASTLANE_RSPEC_JQ_TRANSFORM = (
    r"""tail -n +2 | jq -r '.examples[] | "\(.description) - \(.id) - \(.status)"'"""
)
FPM_RSPEC_JQ_TRANSFORM = (
    r"""sed -n '/^{/,$p' | jq -r '.examples[] | "\(.description) - \(.status)"'"""
)
# Each test case runs multiple times. To reduce the number of tests in
# FAIL_TO_PASS, we group by description and mark failed if any of the tests
# failed
RUBOCOP_RSPEC_JQ_TRANSFORM = r"""
  sed -n '/^{/,$p' | \
  jq -r '.examples | group_by(.description) | .[] |
    if any(select(.status == "failed")) then
      (.[0] | "\(.description) - failed")
    else
      (.[0] | "\(.description) - \(.status)")
    end'
""".strip()

SPECS_JEKYLL = {
    "9141": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["script/bootstrap"],
        "test_cmd": [
            'bundle exec ruby -I test test/test_site.rb -v -n "/static files/"'
        ],
    },
    "8761": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["script/bootstrap"],
        "test_cmd": [
            "bundle exec cucumber --publish-quiet --format progress --no-color features/post_data.feature:6 features/post_data.feature:30"
        ],
    },
    "8047": {
        "docker_specs": {"ruby_version": "3.3"},
        # Remove a gem that is causing installation to fail
        "pre_install": [
            "sed -i '/^[[:space:]]*install_if.*mingw/,/^[[:space:]]*end/d' Gemfile"
        ],
        "install": ["script/bootstrap", "bundle add webrick"],
        "test_cmd": [
            'bundle exec ruby -I test test/test_filters.rb -v -n "/where_exp filter/"'
        ],
    },
    "8167": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["script/bootstrap", "bundle add webrick"],
        "test_cmd": [
            'bundle exec ruby -I test test/test_utils.rb -v -n "/Utils.slugify/"'
        ],
    },
    "8771": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["script/bootstrap"],
        "test_cmd": [
            "bundle exec cucumber --publish-quiet --format progress --no-color features/incremental_rebuild.feature:27 features/incremental_rebuild.feature:70"
        ],
    },
}

SPECS_FLUENTD = {
    "4598": {
        "docker_specs": {"ruby_version": "3.3"},
        # bundler resolves console to 1.30 normally, which causes the test to fail
        "pre_install": ["""echo "gem 'console', '1.29'" >> Gemfile"""],
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/plugin_helper/test_http_server_helper.rb -v -n '/mount/'"
        ],
    },
    "4311": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/config/test_system_config.rb -v -n '/rotate_age/'"
        ],
    },
    "4655": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": ["bundle exec ruby test/plugin/test_in_http.rb -v -n '/test_add/'"],
    },
    "4030": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": ["bundle exec ruby test/plugin/out_forward/test_ack_handler.rb -v"],
    },
    "3917": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": ["bundle exec ruby test/test_config.rb -v"],
    },
    "3640": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/plugin_helper/test_retry_state.rb -v -n '/exponential backoff/'"
        ],
    },
    "3641": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": ["bundle exec ruby test/test_supervisor.rb -v"],
    },
    "3616": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/plugin/test_in_http.rb -v -n '/test_application/'"
        ],
    },
    "3631": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/test_event_router.rb -v -n '/handle_emits_error/'"
        ],
    },
    "3466": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/plugin/test_in_tail.rb -v -n '/test_should_replace_target_info/'"
        ],
    },
    "3328": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/plugin/test_in_tail.rb -v -n '/test_ENOENT_error_after_setup_watcher/'"
        ],
    },
    "3608": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/plugin/test_output_as_buffered_retries.rb -v -n '/retry_max_times/'"
        ],
    },
}

SPECS_FASTLANE = {
    "21857": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install --jobs=$(nproc)"],
        "test_cmd": [
            f"FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/lane_manager_base_spec.rb --no-color --format json | {FASTLANE_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "20958": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install --jobs=$(nproc)"],
        "test_cmd": [
            f"FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/actions_specs/import_from_git_spec.rb --no-color --format json | {FASTLANE_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "20642": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install --jobs=$(nproc)"],
        "test_cmd": [
            f"FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./frameit/spec/device_spec.rb --no-color --format json | {FASTLANE_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "19765": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install --jobs=$(nproc)"],
        "test_cmd": [
            f"FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/actions_specs/download_dsyms_spec.rb --no-color --format json | {FASTLANE_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "20975": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install --jobs=$(nproc)"],
        "test_cmd": [
            f"FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./match/spec/storage/s3_storage_spec.rb --no-color --format json | {FASTLANE_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "19304": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install --jobs=$(nproc)"],
        "test_cmd": [
            f"FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/actions_specs/zip_spec.rb --no-color --format json | {FASTLANE_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "19207": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install --jobs=$(nproc)"],
        "test_cmd": [
            f"FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/actions_specs/zip_spec.rb --no-color --format json | {FASTLANE_RSPEC_JQ_TRANSFORM}",
        ],
    },
}

SPECS_FPM = {
    "1850": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/fpm/package/empty_spec.rb --no-color --format json | {FPM_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "1829": {
        "docker_specs": {"ruby_version": "3.1"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/fpm/package/deb_spec.rb --no-color --format json | {FPM_RSPEC_JQ_TRANSFORM}",
        ],
    },
}

SPECS_FAKER = {
    "2970": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/faker/default/test_faker_internet.rb -v -n '/email/'"
        ],
    },
    "2705": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            "bundle exec ruby test/faker/default/test_faker_internet.rb -v -n '/password/'"
        ],
    },
}

SPECS_RUBOCOP = {
    "13705": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/lint/out_of_range_regexp_ref_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13687": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/lint/safe_navigation_chain_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13680": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/redundant_line_continuation_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13668": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/sole_nested_conditional_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13627": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/multiple_comparison_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13653": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/access_modifier_declarations_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13579": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/layout/line_continuation_spacing_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13560": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/file_null_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13503": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/dig_chain_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13479": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/layout/leading_comment_space_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13431": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/layout/empty_lines_around_method_body_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13424": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/safe_navigation_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13393": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/guard_clause_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13396": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/redundant_parentheses_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13375": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cli_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
    "13362": {
        "docker_specs": {"ruby_version": "3.3"},
        "install": ["bundle install"],
        "test_cmd": [
            f"bundle exec rspec spec/rubocop/cop/style/redundant_freeze_spec.rb --no-color --format json | {RUBOCOP_RSPEC_JQ_TRANSFORM}",
        ],
    },
}


MAP_REPO_VERSION_TO_SPECS_RUBY = {
    "jekyll/jekyll": SPECS_JEKYLL,
    "fluent/fluentd": SPECS_FLUENTD,
    "fastlane/fastlane": SPECS_FASTLANE,
    "jordansissel/fpm": SPECS_FPM,
    "faker-ruby/faker": SPECS_FAKER,
    "rubocop/rubocop": SPECS_RUBOCOP,
}

# Constants - Repository Specific Installation Instructions
MAP_REPO_TO_INSTALL_RUBY = {}

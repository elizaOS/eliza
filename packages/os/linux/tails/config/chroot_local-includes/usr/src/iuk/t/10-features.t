#!/usr/bin/perl

use 5.10.1;
use strictures 2;

use Test::More;

BEGIN {
    eval 'use Test::BDD::Cucumber::Loader';
    plan skip_all => 'Test::BDD::Cucumber::Loader required' if $@;
}

use Path::Tiny;
use Test::BDD::Cucumber::Loader;
use Test::BDD::Cucumber::Harness::TAP;

my @gitlab_ci_compatible_features = (
    'download_upgrade-description_file',
);

for my $feature_dir (path('features')->children) {
    if (defined $ENV{GITLAB_CI} &&
        !grep {$_ eq $feature_dir->basename} @gitlab_ci_compatible_features) {
        say STDERR "$feature_dir skipped: detected GitLab CI";
        next;
    }
    my ($executor, @features) = Test::BDD::Cucumber::Loader->load("$feature_dir");
    my $harness = Test::BDD::Cucumber::Harness::TAP->new({});
    $executor->execute( $_, $harness ) for @features;
}
done_testing;

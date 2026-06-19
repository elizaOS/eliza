#!perl

use strictures 2;

use lib qw{lib t/lib};

use Carp;
use Carp::Assert;
use Carp::Assert::More;
use Cwd;
use Data::Dumper;
use DateTime;
use English qw{-no_match_vars};
use Env;
use File::Copy::Recursive qw{dircopy};
use Function::Parameters;
use IPC::Run;
use IPC::System::Simple qw{systemx};
use Test::More;
use Test::BDD::Cucumber::StepFile;

use Path::Tiny;
use Test::SslCertificates (
    qw{generate_ssl_privkey generate_self_signed_ssl_cert},
    qw{generate_ssl_req generate_ssl_cert populate_ssl_template}
);
use Test::Util;
use Test::WebServer::Static::SSL;
use Test::WebServer::Static::SSL::RedirectToHTTP;

my $bindir = path(__FILE__)->parent->parent->parent->parent->child('bin')->absolute;
my $t_dir  = path(__FILE__)->parent->parent->parent->parent->child('t')->absolute;
my $pristine_dev_gnupg_homedir = path($t_dir, 'data', 'dev_gnupg_homedir');
my $pristine_untrusted_gnupg_homedir = path($t_dir, 'data', 'untrusted_gnupg_homedir');

$ENV{HARNESS_ACTIVE} = 1;

fun expected_upgrade_description_header ($c) {
    Test::Util::upgrade_description_header(
        $c->{stash}->{scenario}->{running}->{product_name},
        $c->{stash}->{scenario}->{running}->{initial_install_version},
        $c->{stash}->{scenario}->{running}->{build_target},
        $c->{stash}->{scenario}->{running}->{channel},
    );
}

Given qr{^a usable temporary directory$}, fun ($c) {
    my $tempdir = $c->{stash}->{scenario}->{tempdir} = Path::Tiny->tempdir(CLEANUP => 0);
    ok(-d $tempdir);
};

Given qr{^a running "([^"]+)", version "([^"]+)", initially installed at version "([^"]+)", targeted at "([^"]+)", using channel "([^"]+)"$}, fun($c) {
    for ((0..4)) {
        assert(exists  $c->matches->[$_]);
        assert(defined $c->matches->[$_]);
        assert(length  $c->matches->[$_]);
    }
    my $product_name            = $c->{stash}->{scenario}->{running}->{product_name}    = $c->matches->[0];
    my $product_version         = $c->{stash}->{scenario}->{running}->{product_version} = $c->matches->[1];
    my $initial_install_version = $c->{stash}->{scenario}->{running}->{initial_install_version} = $c->matches->[2];
    my $build_target            = $c->{stash}->{scenario}->{running}->{build_target}    = $c->matches->[3];
    my $channel                 = $c->{stash}->{scenario}->{running}->{channel}         = $c->matches->[4];
    my $os_release_file
        = $c->{stash}->{scenario}->{os_release_file}
        = path($c->{stash}->{scenario}->{tempdir}, 'os_release_file');
    my %os_release = (
        NAME => $product_name,
        VERSION   => $product_version,
        TAILS_CHANNEL      => $channel,
    );
    while (my ($key, $value) = each %os_release) {
        $os_release_file->append(sprintf('%s="%s"', $key, $value) . "\n");
    }

    my $initial_install_os_release_file
        = $c->{stash}->{scenario}->{initial_install_os_release_file}
        = path($c->{stash}->{scenario}->{tempdir}, 'initial_install_os_release_file');
    my %initial_install_os_release = (
        NAME => $product_name,
        VERSION   => $initial_install_version,
        TAILS_CHANNEL      => $channel,
    );
    while (my ($key, $value) = each %initial_install_os_release) {
        $initial_install_os_release_file->append(
            sprintf('%s="%s"', $key, $value) . "\n"
        );
    }
};

Given qr{^a (HTTP|HTTPS) random port$}, fun ($c) {
    my $port = 40000 + int(rand(10000));
    my $key  = $c->matches->[0] eq 'HTTP' ? 'http_port' : 'https_port';
    $c->{stash}->{scenario}->{server}->{$key} = $port;
    ok(defined $c->{stash}->{scenario}->{server}->{$key});
};

Given qr{^a trusted Certificate Authority$}, fun ($c) {
    my $ca_cert
        = $c->{stash}->{scenario}->{ca_cert}
        = path($c->{stash}->{scenario}->{tempdir}, "ca_cert")->stringify;
    my $ca_privkey
        = $c->{stash}->{scenario}->{ca_privkey}
        = path($c->{stash}->{scenario}->{tempdir}, "ca_privkey")->stringify;
    my $ca_template
        = path($c->{stash}->{scenario}->{tempdir}, "ca_template")->stringify;

    populate_ssl_template({ outfile => $ca_template, ca => 1 });
    assert(-e $ca_template);
    generate_ssl_privkey({ outfile => $ca_privkey });
    assert(-e $ca_privkey);
    generate_self_signed_ssl_cert({
        outfile => $ca_cert, privkey => $ca_privkey, template => $ca_template,
    });
    assert(-e $ca_cert);
};

Given qr{^(a trusted|an untrusted) OpenPGP signing key pair$}, fun ($c) {
    my $trusted = $c->matches->[0] eq 'a trusted' ? 1 : 0;

    my $pristine_gnupg_homedir;
    my $name;

    if ($trusted) {
        $name = 'dev_gnupg_homedir';
        $pristine_gnupg_homedir = $pristine_dev_gnupg_homedir;
    }
    else {
        $name = 'untrusted_gnupg_homedir';
        $pristine_gnupg_homedir = $pristine_untrusted_gnupg_homedir;
    }
    assert(-d $pristine_gnupg_homedir);

    my $gnupg_homedir
        = $c->{stash}->{scenario}->{$name}
        = path($c->{stash}->{scenario}->{tempdir}, "$name")->absolute;

    # may be overridden by the signature steps,
    # but we have to initialize the default case somewhere
    $c->{stash}->{scenario}->{trusted_gnupg_homedir} = $c->{stash}->{scenario}->{dev_gnupg_homedir};

    dircopy($pristine_gnupg_homedir, $gnupg_homedir);
    assert(-d $gnupg_homedir);
    assert(-e path($gnupg_homedir, $_)) for qw{pubring.gpg private-keys-v1.d};
};

Given qr{^a non-existing web server$}, fun ($c) {
    1;
};

Given qr{^an HTTP server on (.*)$}, fun ($c) {
    my $listen = $c->matches->[0];

    my $webroot
        = $c->{stash}->{scenario}->{webroot}
        = path($c->{stash}->{scenario}->{tempdir}, 'webroot');
    $webroot->mkpath;
    assert($webroot->is_dir);

    my $port = $c->{stash}->{scenario}->{server}->{http_port};
    my $s = Test::WebServer::Static->new(
        {
            webroot => $c->{stash}->{scenario}->{webroot},
        },
        $port
    );
    is($s->port(), $port, "Constructor set port correctly");
    my $pid = $c->{stash}->{scenario}->{server}->{http_pid} = $s->background();
    like($pid, '/^-?\d+$/', 'PID is numeric');
};

Given qr{^an HTTPS server with (a valid|an invalid|an expired|a not-valid-yet) SSL certificate(?:, that redirects to ([^ ]+) over cleartext HTTP)?$}, fun ($c) {
    my $type;
    if    ($c->matches->[0] eq q{a valid})         { $type = 'valid';         }
    elsif ($c->matches->[0] eq q{an invalid})      { $type = 'invalid';       }
    elsif ($c->matches->[0] eq q{an expired})      { $type = 'expired';       }
    elsif ($c->matches->[0] eq q{a not-valid-yet}) { $type = 'not-valid-yet'; }

    my $target_hostname = $c->matches->[1];

    my $ssl_cert
        = $c->{stash}->{scenario}->{ssl_cert}
        = path($c->{stash}->{scenario}->{tempdir}, "ssl_cert")->stringify;
    my $ssl_privkey
        = $c->{stash}->{scenario}->{ssl_privkey}
        = path($c->{stash}->{scenario}->{tempdir}, "ssl_privkey")->stringify;
    my $ssl_template
        = path($c->{stash}->{scenario}->{tempdir}, "ssl_template")->stringify;
    my $ssl_req
        = path($c->{stash}->{scenario}->{tempdir}, "ssl_req")->stringify;

    my $ca = $type eq 'valid' ? 0 : 1;
    populate_ssl_template({ outfile => $ssl_template, ca => $ca });
    assert(-e $ssl_template);
    generate_ssl_privkey({ outfile => $ssl_privkey });
    assert(-e $ssl_privkey);
    if ($type =~ m{\A (valid|expired|not-valid-yet) \z}xms) {
        $c->{stash}->{scenario}->{ssl_cert_is_self_signed} = 0;
        generate_ssl_req({ privkey => $ssl_privkey, outfile => $ssl_req, template => $ssl_template });
        assert(-e $ssl_req);
        my $generate_at_dt;
        if ($type eq 'expired') {
            $generate_at_dt = DateTime->now + DateTime::Duration->new(years => -2);
        }
        elsif ($type eq 'not-valid-yet') {
            $generate_at_dt = DateTime->now + DateTime::Duration->new(years => 2);
        }
        my @extra_args;
        if ($type eq 'expired' or $type eq 'not-valid-yet') {
            @extra_args = (
                date => sprintf('%s %s', $generate_at_dt->ymd, $generate_at_dt->hms)
            );
        }
        generate_ssl_cert({
            req => $ssl_req,
            outfile => $ssl_cert,
            ca_cert => $c->{stash}->{scenario}->{ca_cert},
            ca_privkey => $c->{stash}->{scenario}->{ca_privkey},
            template   => $ssl_template,
            @extra_args,
        });
    }
    else {
        $c->{stash}->{scenario}->{ssl_cert_is_self_signed} = 1;
        generate_self_signed_ssl_cert({
            outfile => $ssl_cert, privkey => $ssl_privkey, template => $ssl_template,
        });
    }
    assert(-e $ssl_cert);

    my $webroot
        = $c->{stash}->{scenario}->{webroot}
        = path($c->{stash}->{scenario}->{tempdir}, 'webroot');
    $webroot->mkpath;
    assert($webroot->is_dir);

    my $port = $c->{stash}->{scenario}->{server}->{https_port};
    my $ca_file = $type eq 'invalid'
        ? $c->{stash}->{scenario}->{ssl_cert}
        : $c->{stash}->{scenario}->{ca_cert};
    my $web_server_class = defined $target_hostname
        ? q{Test::WebServer::Static::SSL::RedirectToHTTP}
        : q{Test::WebServer::Static::SSL};
    my @web_server_new_args = defined $target_hostname
        ? (target => $target_hostname, target_port => $c->{stash}->{scenario}->{server}->{http_port})
        : ();
    my $s = $web_server_class->new(
        {
            webroot => $c->{stash}->{scenario}->{webroot},
            cert    => $c->{stash}->{scenario}->{ssl_cert},
            key     => $c->{stash}->{scenario}->{ssl_privkey},
            ca      => $ca_file,
            @web_server_new_args,
        },
        $port
    );
    is($s->port(), $port, "Constructor set port correctly");
    my $pid = $c->{stash}->{scenario}->{server}->{https_pid} = $s->background();
    like($pid, '/^-?\d+$/', 'PID is numeric');
};

fun write_upgrade_description_file ($output, $product_name, $initial_install_version, $build_target, $channel) {
    $output->parent->mkpath;
    $output->spew(
        Test::Util::upgrade_description_header(
            $product_name, $initial_install_version, $build_target, $channel
        )
    );
    assert($output->is_file);
}

fun upgrade_description_file ($c) {
    return $c->{stash}->{scenario}->{upgrade_description_file}
        if exists $c->{stash}->{scenario}->{upgrade_description_file};

    assert(exists  $c->{stash}->{scenario}->{webroot});
    assert(defined $c->{stash}->{scenario}->{webroot});
    assert(length  $c->{stash}->{scenario}->{webroot});
    return $c->{stash}->{scenario}->{upgrade_description_file}
        = path(
            $c->{stash}->{scenario}->{webroot},
            "upgrade/v2/Tails/0.11/s390x/stable/upgrades.yml"
        );
}

Given qr{^(an|no) upgrade-description that matches the initially installed Tails}, fun ($c) {
    my $present = $c->matches->[0] eq 'no' ? 0 : 1;

    if ($present) {
        write_upgrade_description_file(
            upgrade_description_file($c),
            $c->{stash}->{scenario}->{running}->{product_name},
            $c->{stash}->{scenario}->{running}->{initial_install_version},
            $c->{stash}->{scenario}->{running}->{build_target},
            $c->{stash}->{scenario}->{running}->{channel},
        );
    }
};

Given qr{^an upgrade-description that has a different "([^"]+)" than the running Tails}, fun ($c) {
    my $different_field = $c->matches->[0];

    my @args;
    for (qw{product_name initial_install_version},
         qw{build_target channel}) {
        my $arg = $different_field eq $_
            ? "something else"
            : $c->{stash}->{scenario}->{running}->{$_};
        push @args, $arg;
    }

    write_upgrade_description_file(upgrade_description_file($c), @args);
};

Given qr{^an upgrade-description that is too big$}, fun ($c) {
    my $webroot = $c->{stash}->{scenario}->{webroot};
    my $desc    = upgrade_description_file($c);
    my $size = 2**20;

    $desc->parent->mkpath;
    $desc->spew("a" x $size);
};

Given qr{^a signature that is too big$}, fun ($c) {
    my $webroot = $c->{stash}->{scenario}->{webroot};
    my $sig
        = $c->{stash}->{scenario}->{upgrade_description_sig}
        = path(upgrade_description_file($c) . '.pgp');
    my $size = 2**20;

    $sig->parent->mkpath;
    $sig->spew("a" x $size);
};

Given qr{^(a valid|an invalid) signature made by (a trusted|an untrusted) key$}, fun ($c) {
    my $valid              = $c->matches->[0] eq 'a valid' ? 1 : 0;
    my $trusted            = $c->matches->[1] eq 'a trusted' ? 1 : 0;

    my $webroot = $c->{stash}->{scenario}->{webroot};
    my $desc    = upgrade_description_file($c);
    my $sig
        = $c->{stash}->{scenario}->{upgrade_description_sig}
        = path($desc->stringify . '.pgp');

    if ($valid) {
        my $gnupg_homedir;
        if ($trusted) {
            $gnupg_homedir = $c->{stash}->{scenario}->{dev_gnupg_homedir};
            $c->{stash}->{scenario}->{trusted_gnupg_homedir} = $gnupg_homedir;
        }
        else {
            $gnupg_homedir = $c->{stash}->{scenario}->{untrusted_gnupg_homedir};
        }

        my ($stdout, $stderr);
        IPC::Run::run [
            qw{gpg --batch --quiet},
            qw{--armor --detach-sign},
            '--homedir', $gnupg_homedir,
            '--output',  $sig,
            $desc,
        ], '>', \$stdout, '2>', \$stderr
            or croak "gpg exited with $?:\n$stdout\n$stderr";
    }
    else {
        $sig->spew("invalid signature");
    }

    assert(-e $sig);
};

When qr{^I download and check (?:this upgrade-description file|an upgrade-description file from this server)$}, fun ($c) {
    for (qw{ca_cert}) {
        assert(defined $c->{stash}->{scenario}->{$_});
        assert(length  $c->{stash}->{scenario}->{$_});
        assert(-e      $c->{stash}->{scenario}->{$_});
    }

    my $signing_key = Path::Tiny->tempfile;
    unlink $signing_key;
    systemx(
        qw{gpg --batch --no-permission-warning --quiet --armor},
        '--homedir', $c->{stash}->{scenario}->{trusted_gnupg_homedir},
        '--output',  $signing_key,
        '--export'
    );

    my $cmdline = sprintf("%s " .
            "--override_baseurl 'https://127.0.0.1:%s' " .
            "--override_os_release_file '%s' " .
            "--override_initial_install_os_release_file '%s' " .
            "--override_build_target '%s' " .
            "--signing_key '%s'",
        path($bindir, "tails-iuk-get-upgrade-description-file"),
        $c->{stash}->{scenario}->{server}->{https_port},
        $c->{stash}->{scenario}->{os_release_file},
        $c->{stash}->{scenario}->{initial_install_os_release_file},
        's390x',
        $signing_key,
    );
    $ENV{HTTPS_CA_FILE} = $c->{stash}->{scenario}->{ca_cert};
    $c->{stash}->{scenario}->{output} = `$cmdline 2>&1`;
    $c->{stash}->{scenario}->{exit_code} = ${^CHILD_ERROR_NATIVE};
};

Then qr{^it should succeed$}, fun ($c) {
    Test::Util::kill_httpd($c);

    ok(defined $c->{stash}->{scenario}->{exit_code})
        and
    is($c->{stash}->{scenario}->{exit_code}, 0);

    if (defined $c->{stash}->{scenario}->{exit_code}
            && $c->{stash}->{scenario}->{exit_code} != 0
            && exists $c->{stash}->{scenario}->{output}
            && defined $c->{stash}->{scenario}->{output}) {
        warn $c->{stash}->{scenario}->{output};
    }
};

Then qr{^it should fail$}, fun ($c) {
    Test::Util::kill_httpd($c);

    ok(defined $c->{stash}->{scenario}->{exit_code})
        and
    isnt($c->{stash}->{scenario}->{exit_code}, 0);
};

Then qr{^I should be told "([^"]+)"$}, fun ($c) {
    my $expected_err = $c->matches->[0];
    like($c->{stash}->{scenario}->{output}, qr{$expected_err});
};

Then qr{^the upgrade-description content should be printed$}, fun ($c) {
    is($c->{stash}->{scenario}->{output}, expected_upgrade_description_header($c));
};

Then qr{^the downloaded content should be not be much bigger than (\d+)$}, fun ($c) {
    my $expected_size = $c->matches->[0];

    my $not_much_bigger_base   = 4096;
    my $not_much_bigger_factor = 1.20;

    my ($downloaded_size) =
        ( $c->{stash}->{scenario}->{output} =~
              m{but the downloaded content \((\d+)\) should be smaller than} );
    assert(defined($downloaded_size));
    ok($downloaded_size < $not_much_bigger_base + $expected_size * $not_much_bigger_factor );
};

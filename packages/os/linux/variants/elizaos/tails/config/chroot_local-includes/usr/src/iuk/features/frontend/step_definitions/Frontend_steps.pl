#!perl

use strictures 2;

use lib qw{lib t/lib};

use Carp;
use Carp::Assert;
use Carp::Assert::More;
use Data::Dumper;
use English qw{-no_match_vars};
use Env;
use File::Copy::Recursive qw{dircopy};
use File::Find::Rule;
use Function::Parameters;
use IPC::System::Simple qw{capturex systemx};
use Test::More;
use Test::BDD::Cucumber::StepFile;
use Path::Tiny;
use File::Temp qw{tempdir tempfile};
use Tails::IUK::Utils qw{run_as_root};
use Test::SslCertificates (
    qw{generate_ssl_privkey generate_self_signed_ssl_cert},
    qw{generate_ssl_req generate_ssl_cert populate_ssl_template}
);
use Test::Util;
use Test::WebServer::Static::SSL;

my $bindir = path(__FILE__)->parent->parent->parent->parent->child('bin')->absolute;
use Env qw{@PATH};
unshift @PATH, $bindir;

my $t_dir  = path(__FILE__)->parent->parent->parent->parent->child('t')->absolute;
my $pristine_dev_gnupg_homedir = path($t_dir, 'data', 'dev_gnupg_homedir');

my $upgrade_description_file_relative_path = "upgrade/v2/Tails/0.11/s390x/stable/upgrades.yml";
my $upgrade_description_sig_relative_path  = "$upgrade_description_file_relative_path".".pgp";
my $pristine_webroot = path($t_dir, qw{data webroot});

$ENV{HARNESS_ACTIVE} = 1;

Before fun ($c) {
    my $tempdir = $c->{stash}->{scenario}->{tempdir} = Path::Tiny->tempdir(CLEANUP => 0);
    ok(-d $tempdir);
    chmod 0755, $tempdir;
    my $destdir = $c->{stash}->{scenario}->{destdir} = path($tempdir, 'destdir');
    $destdir->mkpath;
    ok($destdir->is_dir);
};

Given qr{^a trusted OpenPGP signing key pair$}, fun ($c) {
    my $pristine_gnupg_homedir;
    my $name;

    $name = 'dev_gnupg_homedir';
    $pristine_gnupg_homedir = $pristine_dev_gnupg_homedir;
    assert(-d $pristine_gnupg_homedir);

    my $gnupg_homedir
        = $c->{stash}->{scenario}->{$name}
        = $c->{stash}->{scenario}->{trusted_gnupg_homedir}
        = path($c->{stash}->{scenario}->{tempdir}, "$name")->absolute;

    dircopy($pristine_gnupg_homedir, $gnupg_homedir);
    assert(-d $gnupg_homedir);
    assert(path($gnupg_homedir, $_)->exists) for qw{pubring.gpg private-keys-v1.d};
};

Given qr{^Tails is running from a (DVD|(|manually installed )USB thumb drive)$}, fun ($c) {
    my $running_from;
    if ($c->matches->[0] eq 'DVD') {
        $running_from = 'dvd';
    }
    else {
        $running_from = $c->matches->[1] eq '' ? 'usb' : 'manual-usb';
    }
    my $os_release_file
        = $c->{stash}->{scenario}->{os_release_file}
        = path($c->{stash}->{scenario}->{tempdir}, 'os_release_file');
    my %os_release = (
        NAME => "Tails",
        VERSION   => "0.11",
        TAILS_CHANNEL      => "stable",
    );
    while (my ($key, $value) = each %os_release) {
        $os_release_file->append(sprintf('%s="%s"', $key, $value) . "\n");
    }

    assert($c->{stash}->{scenario}->{os_release_file}->exists);

    my $initial_install_os_release_file
        = $c->{stash}->{scenario}->{initial_install_os_release_file}
        = path($c->{stash}->{scenario}->{tempdir}, 'initial_install_os_release_file');
    $os_release_file->copy($initial_install_os_release_file);
    assert(-e $c->{stash}->{scenario}->{initial_install_os_release_file});

    $c->{stash}->{scenario}->{dev_dir}
        = path($c->{stash}->{scenario}->{tempdir}, 'dev');
    $c->{stash}->{scenario}->{dev_dir}->mkpath;
    if ($running_from =~ m{usb\z}xms) {
        path($c->{stash}->{scenario}->{dev_dir}, 'bilibop')->touch;
        $c->{stash}->{scenario}->{override_started_from_device_installed_with_tails_installer}
            = $running_from eq 'usb' ? 1 : 0;
    }
    $c->{stash}->{scenario}->{run_dir}
        = path($c->{stash}->{scenario}->{tempdir}, 'run');
    $c->{stash}->{scenario}->{upgrader_run_dir}
        = $c->{stash}->{scenario}->{run_dir}->child('tails-upgrader');
    $c->{stash}->{scenario}->{upgrader_run_dir}->mkpath;
};

Given qr{^a Tails boot device$}, fun ($c) {
    my $liveos_mountpoint
        = $c->{stash}->{scenario}->{liveos_mountpoint}
        = path($c->{stash}->{scenario}->{tempdir}, 'live', 'medium');
    $c->{stash}->{scenario}->{liveos_mountpoint}->mkpath;
    chmod 0755, $c->{stash}->{scenario}->{liveos_mountpoint};

    my $backing_file
        = $c->{stash}->{scenario}->{backing_file}
        = path($c->{stash}->{scenario}->{tempdir}, 'Tails.img');

    my %loop_info = Test::Util::prepare_live_device(
        $backing_file, $liveos_mountpoint
    );
    $c->{stash}->{scenario}->{system_partition} = $loop_info{system_partition};
};

Given qr{^the system has not enough free memory to install this incremental upgrade$}, fun ($c) {
    $c->{stash}->{scenario}->{proc_dir}
        = path($c->{stash}->{scenario}->{tempdir}, 'proc');
    $c->{stash}->{scenario}->{proc_dir}->mkpath;
    path($c->{stash}->{scenario}->{proc_dir}, 'meminfo')->spew(
        'MemTotal: 10 kB' . "\n",
        'MemUsed:   1 kB' . "\n",
        'MemFree:   1 kB' . "\n",
        'Buffers:   1 kB' . "\n",
        'Cached:    1 kB' . "\n",
        'SwapTotal: 0 kB' . "\n",
        'SwapFree:  0 kB' . "\n",
    );
};

Given qr{^an HTTPS server with a valid SSL certificate$}, fun ($c) {
    $c->{stash}->{scenario}->{server}->{https_port} = 40000 + int(rand(10000));
    ok(defined $c->{stash}->{scenario}->{server}->{https_port});

    $ENV{TAILS_FALLBACK_DL_URL_PORT} =
        $c->{stash}->{scenario}->{server}->{https_port};

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

    populate_ssl_template({ outfile => $ssl_template, ca => 1 });
    assert(-e $ssl_template);
    generate_ssl_privkey({ outfile => $ssl_privkey });
    assert(-e $ssl_privkey);

    generate_ssl_req({ privkey => $ssl_privkey, outfile => $ssl_req, template => $ssl_template });
    assert(-e $ssl_req);

    generate_ssl_cert({
        req => $ssl_req,
        outfile => $ssl_cert,
        ca_cert => $c->{stash}->{scenario}->{ca_cert},
        ca_privkey => $c->{stash}->{scenario}->{ca_privkey},
        template   => $ssl_template,
    });
    assert(-e $ssl_cert);

    my $webroot
        = $c->{stash}->{scenario}->{webroot}
        = path($c->{stash}->{scenario}->{tempdir}, 'webroot');
    dircopy($pristine_webroot, $webroot);
    assert($webroot->is_dir);

    my $port = $c->{stash}->{scenario}->{server}->{https_port};
    my $ca_file = $c->{stash}->{scenario}->{ca_cert};
    my $s = Test::WebServer::Static::SSL->new(
        {
            webroot => $c->{stash}->{scenario}->{webroot},
            cert    => $c->{stash}->{scenario}->{ssl_cert},
            key     => $c->{stash}->{scenario}->{ssl_privkey},
            ca      => $ca_file,
        },
        $port
    );
    is($s->port(), $port, "Constructor set port correctly");
    my $pid = $c->{stash}->{scenario}->{server}->{https_pid} = $s->background();
    like($pid, '/^-?\d+$/', 'PID is numeric');

    path($webroot, 'tails-signing-minimal.key')->spew(
        capturex(
            'gpg', '--homedir', $c->{stash}->{scenario}->{trusted_gnupg_homedir},
                   '--batch', '--no-permission-warning',
                   '--armor', '--export'
        )
    );
};

fun generate_upgrade_description($output, $name, $initial_install_version, $target, $channel, $gnupg_homedir, $port, $has_incremental_upgrade = 0, $has_full_upgrade = 0) {
    my $desc = path($output);
    my $sig  = path($output.".pgp");

    $desc->parent->mkpath;
    $desc->spew(Test::Util::upgrade_description_header($name, $initial_install_version, $target, $channel));
    if ($has_incremental_upgrade or $has_full_upgrade) {
        $desc->append(<<EOF
upgrades:
  - version: 0.12.1
    type: minor
    details-url: https://tails.net/news/version_0.12.1/
    upgrade-paths:

EOF
        );
    }
    if ($has_incremental_upgrade) {
        $desc->append(<<EOF
      - type: incremental
        target-files:
          - url: https://127.0.0.1:$port/tails/stable/iuk/v2/Tails_s390x_0.11_to_0.12.1.iuk
            size: 4096
            sha256: 09ded037840f60aae20e639ee285f54974f919a9d08f1669f807ced456f50af3
EOF
        );
    }
    if ($has_full_upgrade) {
        $desc->append(<<EOF
      - type: full
        target-files:
          - url: https://127.0.0.1:$port/tails/stable/tails-s390x-0.12.1/Tails-s390x-0.12.1.iso
            size: 762123456
            sha256: a38c8b6566946170cb4ac806a36f20ddf0758a21b178b6f74c8268bbd7ecf8ab
EOF
        );
    }
    assert(-e $desc);

    capturex(
        qw{gpg --batch --quiet --no-permission-warning},
        qw{--armor --detach-sign},
        '--homedir', $gnupg_homedir,
        '--output',  $sig,
        $desc,
    );
    assert(-e $sig);
}

Given qr{^no upgrade is available$}, fun ($c) {
    my $desc = path(
        $c->{stash}->{scenario}->{webroot},
        $upgrade_description_file_relative_path,
    );
    my $sig  = path(
        $c->{stash}->{scenario}->{webroot},
        $upgrade_description_sig_relative_path,
    );
    generate_upgrade_description(
        $desc,
        "Tails", "0.11", "s390x", "stable",
        $c->{stash}->{scenario}->{dev_gnupg_homedir},
        $c->{stash}->{scenario}->{server}->{https_port},
    );
};

Given qr{^it is not known whether an upgrade is available$}, fun ($c) {
    1;
};

Given qr{^both incremental and full upgrades are available$}, fun ($c) {
    my $desc = path(
        $c->{stash}->{scenario}->{webroot},
        $upgrade_description_file_relative_path,
    );
    my $sig  = path(
        $c->{stash}->{scenario}->{webroot},
        $upgrade_description_sig_relative_path,
    );
    generate_upgrade_description(
        $desc,
        "Tails", "0.11", "s390x", "stable",
        $c->{stash}->{scenario}->{dev_gnupg_homedir},
        $c->{stash}->{scenario}->{server}->{https_port},
        "has incremental upgrade", "has full upgrade"
    );
};

Given qr{^no incremental upgrade is available, but a full upgrade is$}, fun ($c) {
    my $desc = path(
        $c->{stash}->{scenario}->{webroot},
        $upgrade_description_file_relative_path,
    );
    my $sig  = path(
        $c->{stash}->{scenario}->{webroot},
        $upgrade_description_sig_relative_path,
    );
    generate_upgrade_description(
        $desc,
        "Tails", "0.11", "s390x", "stable",
        $c->{stash}->{scenario}->{dev_gnupg_homedir},
        $c->{stash}->{scenario}->{server}->{https_port},
        0, "has full upgrade"
    );
};

Given qr{^a target file does not exist$}, fun ($c) {
    my @iuks = File::Find::Rule->file()
        ->name( '*.iuk' ) ->in($c->{stash}->{scenario}->{webroot});
    unlink for (@iuks);
};

Given qr{^a target file is corrupted$}, fun ($c) {
    my @iuks = File::Find::Rule->file()
        ->name( '*.iuk' ) ->in($c->{stash}->{scenario}->{webroot});
    foreach my $iuk (@iuks) {
        path($iuk)->spew("this is a corrupted IUK");
    }
};

Given qr{^the system partition has not enough free space to install this incremental upgrade$}, fun ($c) {
    $c->{stash}->{scenario}->{free_space} = 42;
};

When qr{^I run tails-upgrade-frontend(| in batch mode)$}, fun ($c) {
    my $batch = defined $c->matches->[0] && length defined $c->matches->[0];

    my $signing_key = Path::Tiny->tempfile;
    unlink $signing_key;
    systemx(
        qw{gpg --batch --quiet --no-permission-warning --armor},
        '--homedir', $c->{stash}->{scenario}->{trusted_gnupg_homedir},
        '--output',  $signing_key,
        '--export'
    );

    my $cmdline = sprintf("%s " .
            "--override_baseurl 'https://127.0.0.1:%s' " .
            "--override_dev_dir '%s' " .
            "--override_run_dir '%s' " .
            "--override_os_release_file '%s' " .
            "--override_initial_install_os_release_file '%s' " .
            "--override_build_target '%s' " .
            "--override_signing_key '%s' ".
            "--override_liveos_mountpoint '%s' ",
        path($bindir, "tails-upgrade-frontend"),
        $c->{stash}->{scenario}->{server}->{https_port},
        $c->{stash}->{scenario}->{dev_dir},
        $c->{stash}->{scenario}->{run_dir},
        $c->{stash}->{scenario}->{os_release_file},
        $c->{stash}->{scenario}->{initial_install_os_release_file},
        's390x',
        $signing_key,
        $c->{stash}->{scenario}->{liveos_mountpoint},
    );
    $cmdline .= " --batch " if $batch;
    $cmdline .= sprintf(
        " --override_started_from_device_installed_with_tails_installer '%s' ",
        $c->{stash}->{scenario}->{override_started_from_device_installed_with_tails_installer},
    ) if exists $c->{stash}->{scenario}->{override_started_from_device_installed_with_tails_installer};
    $cmdline .= sprintf(" --override_proc_dir '%s' ", $c->{stash}->{scenario}->{proc_dir})
        if exists $c->{stash}->{scenario}->{proc_dir};
    $cmdline .= sprintf(" --override_free_space '%s' ", $c->{stash}->{scenario}->{free_space})
        if exists $c->{stash}->{scenario}->{free_space};

    $ENV{HTTPS_CA_FILE} = $c->{stash}->{scenario}->{ca_cert};
    $c->{stash}->{scenario}->{output} = `$cmdline 2>&1`;
    $c->{stash}->{scenario}->{exit_code} = ${^CHILD_ERROR_NATIVE};
};

Then qr{^it should succeed$}, fun ($c) {
    ok(defined $c->{stash}->{scenario}->{exit_code})
        and
    is($c->{stash}->{scenario}->{exit_code}, 0);

    if (defined $c->{stash}->{scenario}->{exit_code}
            && $c->{stash}->{scenario}->{exit_code} != 0
            && exists $c->{stash}->{scenario}->{output}
            && defined $c->{stash}->{scenario}->{output}) {
        warn $c->{stash}->{scenario}->{output};
    }

    ok(-e $c->{stash}->{scenario}->{upgrader_run_dir}
                                 ->child('checked_upgrades'));
};

Then qr{^it should fail to (check for upgrades|download the upgrade)$}, fun ($c) {
    ok(defined $c->{stash}->{scenario}->{exit_code})
        and
    isnt($c->{stash}->{scenario}->{exit_code}, 0);

    if ($c->matches->[0] eq 'check for upgrades') {
        ok(! -e $c->{stash}->{scenario}->{upgrader_run_dir}
                                       ->child('checked_upgrades'));
    }
    else {
        ok(-e $c->{stash}->{scenario}->{upgrader_run_dir}
                                     ->child('checked_upgrades'));
    }
};

Then qr{^I should not be told anything}, fun ($c) {
    is($c->{stash}->{scenario}->{output}, "");
};

Then qr{^I should be told "([^"]+)"$}, fun ($c) {
    my $expected_err = $c->matches->[0];
    like($c->{stash}->{scenario}->{output}, qr{$expected_err});
};

Then qr{^I should be proposed to install this incremental upgrade$}, fun ($c) {
    like($c->{stash}->{scenario}->{output}, qr{^Upgrade available$}m); # dialog title
    like(
        $c->{stash}->{scenario}->{output},
        qr{You should upgrade to Tails 0[.]12[.]1}
    );
    like($c->{stash}->{scenario}->{output}, qr{: Upgrade}); # dialog button
};

Then qr{^I should be proposed to download this full upgrade$}, fun ($c) {
    like($c->{stash}->{scenario}->{output}, qr{^New version available$}m); # dialog title
    like(
        $c->{stash}->{scenario}->{output},
        qr{You should do a manual upgrade to}
    );
};

Then qr{^I should be asked to wait$}, fun ($c) {
    like(
        $c->{stash}->{scenario}->{output},
        qr{Downloading the upgrade to Tails}
    );
};

Then qr{^the network should be shutdown$}, fun ($c) {
    like(
        $c->{stash}->{scenario}->{output},
        qr{Shutting down network connection}
    );
};

Then qr{^the downloaded IUK should be installed$}, fun ($c) {
    # the overlay directory in the test IUK contains a "placeholder" file
    ok(path($c->{stash}->{scenario}->{liveos_mountpoint}, 'placeholder')->exists);
    # Ensure the next "I run tails-upgrade-frontend in batch mode"
    # is aware that the upgrade was applied
    $c->{stash}->{scenario}->{os_release_file}->edit_lines(
        sub { s{\AVERSION="0[.]11"$}{VERSION="0.12.1"}xms }
    );
};

Then qr{^I should be proposed to restart the system$}, fun ($c) {
    like($c->{stash}->{scenario}->{output}, qr{^Restart Tails$}m); # dialog title
    like(
        $c->{stash}->{scenario}->{output},
        qr{You should restart Tails}
    );
    like(
        $c->{stash}->{scenario}->{output},
        qr{Restart now / Restart later} # dialog buttons
    );
};

Then qr{^the system should be restarted$}, fun ($c) {
    like(
        $c->{stash}->{scenario}->{output},
        qr{Restarting the system}
    );
};

After fun ($c) {
    Test::Util::kill_httpd($c);
    run_as_root('umount', $c->{stash}->{scenario}->{liveos_mountpoint});
    ${^CHILD_ERROR_NATIVE} == 0 or croak("Failed to umount system partition.");
    run_as_root(qw{kpartx -d}, $c->{stash}->{scenario}->{backing_file});
    ${^CHILD_ERROR_NATIVE} == 0 or croak("Failed to delete device mapping: $?.");
    $c->{stash}->{scenario}->{tempdir}->remove_tree;
};

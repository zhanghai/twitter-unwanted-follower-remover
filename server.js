'use strict';

const crypto = require('crypto');
const querystring = require('querystring');
const readline = require('readline');
const util = require('util');

const chalk = require('chalk');
const { DateTime, Duration } = require('luxon');
const fetch = require('node-fetch');
const OAuth = require('oauth-1.0a');

const config = require('./config.js');

const sleep = util.promisify(setTimeout)

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

async function question(prompt) {
    return new Promise(resolve => rl.question(prompt, line => resolve(line)));
}

function chalkRedIf(text, red) {
    return red ? chalk.red(text) : text;
}

const oauth = OAuth({
    consumer: {
        key: config.consumerKey,
        secret: config.consumerSecret,
    },
    signature_method: 'HMAC-SHA1',
    hash_function: (baseString, key) => crypto.createHmac('sha1', key).update(baseString).digest('base64'),
});

async function getRequestToken() {
    const url = 'https://api.twitter.com/oauth/request_token?oauth_callback=oob';
    const headers = oauth.toHeader(oauth.authorize({
        url,
        method: 'POST',
    }));
    const response = await fetch(url, {
        method: 'POST',
        headers,
    });
    const responseText = await response.text();
    if (!response.ok) {
        throw responseText;
    }
    const responseBody = querystring.parse(responseText);
    console.debug(responseBody);
    return {
        key: responseBody.oauth_token,
        secret: responseBody.oauth_token_secret,
    };
}

function getAuthorizeUrl(requestToken) {
    const url = new URL('https://api.twitter.com/oauth/authorize');
    url.searchParams.append('oauth_token', requestToken.key);
    return url.href;
}

async function getAccessToken(requestToken, pin) {
    const url = `https://api.twitter.com/oauth/access_token?oauth_token=${requestToken.key}&oauth_verifier=${pin}`
    const headers = oauth.toHeader(oauth.authorize({
        url,
        method: 'POST',
    }));
    const response = await fetch(url, {
        method: 'POST',
        headers,
    });
    const responseText = await response.text();
    if (!response.ok) {
        throw responseText;
    }
    const responseBody = querystring.parse(responseText);
    console.debug(responseBody);
    return {
        accessToken: {
            key: responseBody.oauth_token,
            secret: responseBody.oauth_token_secret,
        },
        userId: responseBody.user_id,
        screenName: responseBody.screen_name,
    };
}

async function fetchApi(url, accessToken, init) {
    const headers = oauth.toHeader(oauth.authorize({
        url,
        method: init?.method || 'GET',
    }, accessToken));
    if (init && init.body) {
        init.body = JSON.stringify(init.body);
    }
    const response = await fetch(url, {
        headers: {
            ...headers,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        ...init,
    });
    const responseBody = await response.json();
    if (!response.ok) {
        throw responseBody;
    }
    console.debug(responseBody);
    return responseBody;
}

async function main() {
    const requestToken = await getRequestToken();
    const authorizeUrl = getAuthorizeUrl(requestToken);
    console.log(`Please open ${authorizeUrl} and authorize this application.`);
    const pin = (await question('PIN: ')).trim();
    const { accessToken, userId } = await getAccessToken(requestToken, pin);

    const followers = (await fetchApi(`https://api.twitter.com/1.1/followers/list.json?user_id=${userId}&count=200`, accessToken)).users;
    const friendIds = (await fetchApi(`https://api.twitter.com/1.1/friends/ids.json?user_id=${userId}&count=5000`, accessToken)).ids;
    for (const follower of followers) {
        if (friendIds.includes(follower.id)) {
            continue;
        }

        const screenName = follower.screen_name;
        const isGeneratedScreenName = /^[A-Za-z_]+[0-9]{8,}$/u.test(screenName);
        const isProtected = follower.protected;
        const friendsCount = follower.friends_count;
        const followersCount = follower.followers_count;
        const friendFollowerRatio = friendsCount / (followersCount || 1);
        const hasTooManyFriends = followersCount > 10 ? friendFollowerRatio > 10 : friendFollowerRatio > 100;
        const tweetsCount = follower.statuses_count;
        const hasTooFewTweets = tweetsCount < 10;
        const createdAt = DateTime.fromFormat(follower.created_at, 'EEE MMM dd HH:mm:ss ZZZ y');
        const age = DateTime.now().diff(createdAt);
        const isTooYoung = age < Duration.fromObject({ months: 1 });
        const unwantedFlags = [isGeneratedScreenName, isProtected, hasTooManyFriends, hasTooFewTweets, isTooYoung];
        const isLikelyUnwanted = unwantedFlags.some(it => it);

        console.log('================================================================================');
        console.log(`${follower.name}${follower.verified ? ' 🛡' : ''}${isProtected ? ` ${chalk.bgRed('🔒')}` : ''} (@${chalkRedIf(screenName, isGeneratedScreenName)})`);
        if (follower.description) {
            console.log(follower.description);
        }
        if (follower.url) {
            console.log(follower.url);
        }
        console.log(`🧑 ${chalkRedIf(`${friendsCount} / ${followersCount}`, hasTooManyFriends)} ⏱️  ${chalkRedIf(createdAt.toLocaleString(DateTime.DATE_FULL), isTooYoung)}${follower.location ? ` 📍 ${follower.location}` : ''} 🐦 ${chalkRedIf(tweetsCount, hasTooFewTweets)}`);
        console.log(`https://twitter.com/${screenName}`);
        console.log(`Unwanted score: ${unwantedFlags.filter(it => it).length}/${unwantedFlags.length}`);
        console.log('================================================================================');
        let shouldRemoveFollower = null;
        while (shouldRemoveFollower === null) {
            const line = await question(`Remove follower? (${isLikelyUnwanted ? 'Y/n' : 'y/N'}): `);
            const response = line.trim().toLowerCase();
            switch (response) {
                case 'y':
                    shouldRemoveFollower = true;
                    break;
                case 'n':
                    shouldRemoveFollower = false;
                    break;
                case '':
                    shouldRemoveFollower = isLikelyUnwanted;
                    break;
            }
        }

        if (shouldRemoveFollower) {
            await fetchApi(`https://api.twitter.com/1.1/blocks/create.json?user_id=${follower.id_str}&skip_status=1`, accessToken, { method: 'POST' });
            await sleep(3000);
            await fetchApi(`https://api.twitter.com/1.1/blocks/destroy.json?user_id=${follower.id_str}&skip_status=1`, accessToken, { method: 'POST' });
        }
    }
}

(async function () {
    try {
        await main();
    } catch (e) {
        console.error(e);
        process.exit(-1);
    }
})();

/* eslint no-await-in-loop: off */
// Linter configuration, cannot avoit await in loop due to API rate limits
// (Update: yes you can, set array of promises and wait for each one)
const constants = require('./const.js');

const mustache = require('mustache');
const fs = require('fs');
const expa = require('node-gis-wrapper')(constants.devUser, constants.devPass);
const sendgrid = require('@sendgrid/mail');

sendgrid.setApiKey(constants.sendgrid);

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at:', p, 'reason:', reason);
});

// EXPA Setup Constants (affects the execution of the script overall)
const EY = {
  MEXICO: 1589,
};

const PRODUCTION_ENV = 'production';
const NODE_ENV = process.env.NODE_ENV || 'development';
const CURR_PROD = process.env.PRODUCT || 'GV';

const MAIL_TEMPLATE = Object.freeze({
  GV: `${__dirname}/template_gv.mst`,
  GT: `${__dirname}/template_gt.mst`,
  GE: `${__dirname}/template_ge.mst`,
});

const START_DATE = getStartDate();
const PER_PAGE = 50;
const PARALLEL = 3;
const applicationsUrl = 'applications.json';

// Ordered list of LCs (alphabetical name)
const LCs = constants.lcs.map(el => ({ id: el.id, name: el.name })).sort((a, b) => a.name.toString().localeCompare(b.name, 'la'))
//  .slice(0,3); // For testing with a smaller sample

const PRODUCT = Object.freeze({
  iGT: { name: 'iGT', type: 'opportunity', programme: 2 },
  oGT: { name: 'oGT', type: 'person', programme: 2 },
  iGV: { name: 'iGV', type: 'opportunity', programme: 1 },
  oGV: { name: 'oGV', type: 'person', programme: 1 },
  iGE: { name: 'iGE', type: 'opportunity', programme: 5 },
  oGE: { name: 'oGE', type: 'person', programme: 5 },
});

try {
  main();
} catch (err) {
  console.log('Main catch');
  console.error(err);
}

async function main() {
  // Get all OGX applications from the start date until today
  if (NODE_ENV !== PRODUCTION_ENV) console.log('Non-production environment, sending LC emails to sendgrid sink domain.');
  console.log(`Retrieving all ${CURR_PROD} applications since ${START_DATE}...`);
  const applications = await getProductApplications(CURR_PROD, START_DATE, EY.MEXICO);
  console.log(`There are ${applications.length} applications retrieved`);

  LCs.forEach(async (lc) => {
    try { // Do synchronous email sending instead of asynchronous
      const lcApps = applications.filter(app => app.person.home_lc.id === lc.id);

      const open = filterAndFormatApplicationByStatus(lcApps, 'open');
      const accepted = filterAndFormatApplicationByStatus(lcApps, 'matched');
      const inProgress = filterAndFormatApplicationByStatus(lcApps, 'accepted');
      const approved = filterAndFormatApplicationByStatus(lcApps, 'approved');

      const html = mustacheRender(open, accepted, inProgress, approved, lc.name);

      // Check if there is an email address to send
      let lcEmails = constants.emails.find(el => el.id === lc.id);
      if (lcEmails && lcEmails[`to${CURR_PROD}`]) {
        if (NODE_ENV !== PRODUCTION_ENV) {
          lcEmails = lcEmails[`to${CURR_PROD}`].map(el => el.replace('@aiesec.org.mx', '@sink.sendgrid.net'));
        }
        sendgrid.send({
          to: lcEmails[`to${CURR_PROD}`],
          bcc: constants.CC_EMAIL[`to${CURR_PROD}`],
          from: 'AIESEC in Mexico <noreply@aiesec.org.mx>',
          subject: `o${CURR_PROD} - EXPA Update`,
          html,
        }).then(() => {
          console.log(`Sent email to ${lc.name}`);
        }).catch(err => console.log('Sendgrid error',err.toString()));
      } else {
        console.log(`Skipping email for ${lc.name}, no to${CURR_PROD} field found.`);
      }
    } catch (err) {
      console.log(`There was an error while sending message to LC ${lc.name}:`,err);
    }
  });
}

async function getProductApplications(prod, startDate, ey) {
  switch (prod) {
    case 'GT':
      return getOGTApplications(startDate, ey);
    case 'GE':
      return getOGEApplications(startDate, ey);
    default: // GV is default product
      return getOGVApplications(startDate, ey);
  }
}

function prepareArrays(open, accepted, inProgress, approved) {
  const openNew = open.reduce((a, el) => {
    let res;

    const found = a.find(acc => acc.person.id === el.person.id);
    if (found === undefined) {
      res = {
        count: 1,
        person: {
          id: el.person.id,
          url: el.person.url,
          full_name: el.person.full_name,
          email: el.person.email,
          home_lc: el.person.home_lc,
        },
      };
      a.push(res);
    } else { found.count += 1; }
    return a;
  }, Array.from([]));

  const acceptedNew = accepted;
  const inProgressNew = inProgress.map((el) => {
    const e = el;
    e.hasLDM = e.permissions.has_completed_ldm;
    e.hasPayed = e.permissions.has_paid_for_match;
    return e;
  });


  return {
    openNew,
    acceptedNew,
    inProgressNew,
    approvedNew: approved,
  };
}

function mustacheRender(open, accepted, inProgress, approved, lc) {
  const template = fs.readFileSync(MAIL_TEMPLATE[CURR_PROD]).toString('utf8');

  const res = prepareArrays(open, accepted, inProgress, approved);

  const data = {
    lc,
    openNo: res.openNew.length,
    acceptedNo: res.acceptedNew.length,
    inProgressNo: res.inProgressNew.length,
    approvedNo: res.approvedNew.length,
    open: res.openNew,
    accepted: res.acceptedNew,
    inProgress: res.inProgressNew,
    approved: res.approvedNew,
  };

  const rendered = mustache.render(template, data);

  return rendered;
}

function filterAndFormatApplicationByStatus(apps, status) {
  const PEOPLE_URL = 'https://experience.aiesec.org/#/people/';
  const OPPORTUNITY_URL = 'https://experience.aiesec.org/#/opportunity/';

  return apps.filter(el => el.status === status).map(el => ({
    id: el.id,
    person: {
      id: el.person.id,
      email: el.person.email,
      url: `${PEOPLE_URL + el.person.id}/applications`,
      full_name: el.person.full_name,
      ldm_to_complete: el.person.ldm_to_complete,
      home_lc: el.person.home_lc,
    },
    an_signed_at: el.an_signed_at,
    opportunity: {
      id: el.opportunity.id,
      url: OPPORTUNITY_URL + el.opportunity.id,
      office: {
        id: el.opportunity.office.id,
        name: el.opportunity.office.name,
        country: el.opportunity.office.country,
      },
    },
    permissions: el.permissions,
    updated_at: el.updated_at,
  }));
}

async function getOGTApplications(start, lc) {
  console.log('Called Get OGT Applications');
  try {
    const params = {
      'filters[created_at][from]': start,
      'filters[person_committee]': lc,
      'filters[programmes][]': PRODUCT.oGT.programme,
    };

    return await getApplicationsFromEXPA(params);
  } catch (err) {
    console.error(err);
    throw Error('getOGTApplications Failed!');
  }
}

async function getOGEApplications(start, lc) {
  console.log('Called Get OGE Applications');
  try {
    const params = {
      'filters[created_at][from]': start,
      'filters[person_committee]': lc,
      'filters[programmes][]': PRODUCT.oGE.programme,
    };

    return await getApplicationsFromEXPA(params);
  } catch (err) {
    console.error(err);
    throw Error('getOGEApplications Failed!');
  }
}

async function getOGVApplications(start, lc) {
  try {
    const params = {
      'filters[created_at][from]': start,
      'filters[person_committee]': lc,
      'filters[programmes][]': PRODUCT.oGV.programme,
    };

    return await getApplicationsFromEXPA(params);
  } catch (err) {
    console.error(err);
    throw Error('getOGVApplications Failed!');
  }
}

async function getApplicationsFromEXPA(params) {
  const promises = [];
  let retrieved = 0;
  let data = [];

  console.log('Getting number of total items from EXPA...');
  console.time('Timer');
  let sentParams = Object.assign({ page: 1, per_page: 1 }, params);
  const res = await getWithPaging(applicationsUrl, sentParams);
  const items = res.paging.total_items;
  const totalPages = Math.ceil(items / PER_PAGE);

  sentParams = Object.assign({ page: 1, per_page: PER_PAGE }, params);
  console.log(`Done! Total items: ${items}`);
  console.log(`Per page: ${PER_PAGE}, Total Pages: ${totalPages}`);
  console.timeEnd('Timer');

  do {
    let i = 0;

    console.log('Bulk retrieving pages...');
    while (i < PARALLEL && totalPages >= sentParams.page) {
      console.log(sentParams.page);

      promises.push(getWithPaging(applicationsUrl, Object.assign({}, sentParams)));
      sentParams.page += 1;
      i += 1;
    }

    console.log('Waiting for pages...');
    data = await Promise.all(promises);
    console.log('Done!');

    // console.log(promises); //Prints promises
    retrieved += PER_PAGE * PARALLEL;
  } while (retrieved < items);


  return data.map(el => el.data).reduce((a, c) => a.concat(c));
}


function getStartDate() {
  return '2018-02-01';
}

async function getWithPaging(url, data, tried) {
  let tries;
  if (!tried) {
    tries = 1;
  } else {
    tries = tried;
  }

  return req(expa.get, url, data).then((res) => {
    if (!res.paging) throw res;
    console.log(`Retrieved page: ${res.paging.current_page}`);
    return res;
  }).catch((err) => {
    console.log(`Retrieving info failed for page ${data.page}, retrying... ${err ? JSON.stringify(err) : ''}`);
    if (tries <= 3) {
      tries += 1;
      return getWithPaging(url, data, tries);
    }
    throw Error(`Too many tries while retrieving page ${data.page} in EXPA`);
  });
}
// Function definition. Interactions with node-gis-wrapper functions to use ES6 Promises
/* async function post(url, data) { return req(expa.post, url, data); }
async function patch(url, data) { return req(expa.patch, url, data); } */
async function req(fn, url, data) {
  return fn(url, data).then(msg => Promise.resolve(msg)).catch(err => Promise.reject(err));
}

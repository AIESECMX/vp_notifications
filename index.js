const config = require('./config.js');
const constants = require('./const.js');

const mustache = require('mustache');
const fs = require('fs');
const nodemailer = require('nodemailer');
var pdf = require('html-pdf');
var pdfOptions = { format: 'Letter', "orientation": "landscape" };

var expa = require('node-gis-wrapper')(config.devUser,config.devPass);

const MAIL_OUTPUT = '/home/serch/MCVPDI1718/vp_notifications/out.html'
const MAIL_TEMPLATE = '/home/serch/MCVPDI1718/vp_notifications/template.mst'
const MC_PDF_TEMPLATE = '/home/serch/MCVPDI1718/vp_notifications/template_mc.mst'
const MC_MAIL_TEMPLATE = '/home/serch/MCVPDI1718/vp_notifications/mcmail.html'
const USER = constants.gmail.user;
const PASS = constants.gmail.pass;

//EXPA Setup Constants (affects the performance of the script overall)
const START_DATE = getStartDate(); //Start Date is today minus thirty days
const PER_PAGE = 50;
const PARALLEL = 3;
const applicationsUrl = 'applications.json';

const EY = {
	MEXICO : 1589,
};

//Ordered list of LCs (alphabetical name)
const LCs = constants.lcs.map(el => ({id:el.id,name:el.name})).sort((a,b) => a.name.toString().localeCompare(b.name,'la'));

const PRODUCT = Object.freeze({
	iGT: {"name":"iGT", "type" : "opportunity", "programme": 2},
	oGT: {"name":"oGT", "type" : "person", "programme": 2},
	iGV: {"name":"iGV", "type" : "opportunity", "programme": 1},
	oGV: {"name":"oGV", "type" : "person", "programme": 1},
	iGE: {"name":"iGE", "type" : "opportunity", "programme": 5},
	oGE: {"name":"oGE", "type" : "person", "programme": 5},
});

try{
	main();
} catch(err) {
	console.log("Main catch");
	console.error(err);
}

async function main() {

	//Get all OGX applications from the start date until today
	console.log("Retrieving all applications since "+START_DATE+"..."); 
	var applications = await getOGVApplications(START_DATE,EY.MEXICO);
	
	var email,fakeEmail;
	// create Reusable Transporter object using the default SMTP transport
    email = nodemailer.createTransport({
        service: "Gmail",
        auth: {
            user: USER,
            pass: PASS 
        }
    });

    open = filterAndFormatApplicationByStatus(applications,'open');
	accepted = filterAndFormatApplicationByStatus(applications,'matched');
	inProgress = filterAndFormatApplicationByStatus(applications,'accepted');
	approved = filterAndFormatApplicationByStatus(applications,'approved');

	let body = mustacheMCRender(open,accepted,inProgress,approved,LCs);

	//Changed: Disables PDF Writing because it's too big. Better find another solution,
	//         like a database for querying the information.
	/*console.log("Writing PDF");
	var buffer = await new Promise( (resolve,reject) => pdf.create(body,pdfOptions).toBuffer((err,buffer) => {
		if(err) reject(err);
		else resolve(buffer);
	}));
	console.log("Done!")

	let mailOptions = {
		from: constants.FROM_DATA, // sender address
		to: constants.emails.find(el => el.id==EY.MEXICO).toGV.toString(), // list of receivers
		subject: 'Daily oGV Update', // Subject line
		html: fs.readFileSync(MC_MAIL_TEMPLATE).toString('utf8'), // html body
		attachments: [
	        {   // utf-8 string as an attachment
	        	filename: 'oGV Update.pdf',
	        	content: buffer
	        },
        ]
	};

	try { //Do synchronous email sending instead of asynchronous
		var info = await sendEmail(email,mailOptions);
		console.log('Sent email');
		if(fakeEmail) {
			console.log(nodemailer.getTestMessageUrl(info));
		}
	} catch(err) {
		console.log("There was an error while sending message to MC");
		console.error(err);
	}*/

	var lcApps,open,accepted,inProgress,approved,rejected,withdrawn,total;
	for(let lc of LCs) {
		lcApps = applications.filter(app => app.person.home_lc.id==lc.id);
		
		open = filterAndFormatApplicationByStatus(lcApps,'open');
		accepted = filterAndFormatApplicationByStatus(lcApps,'matched');
		inProgress = filterAndFormatApplicationByStatus(lcApps,'accepted');
		approved = filterAndFormatApplicationByStatus(lcApps,'approved');

		console.log('LC: '+lc.name);

		let body = mustacheRender(open,accepted,inProgress,approved,lc.name);

		let mailOptions = {
			from: constants.FROM_DATA,
			to: constants.emails.find(el => el.id==lc.id).toGV.toString(), // list of receivers
			cc: constants.CC_EMAIL,
			subject: 'Daily oGV Update - '+lc.name, // Subject line
			html: body // html body
		};
		
		try { //Do synchronous email sending instead of asynchronous
			var info = await sendEmail(email,mailOptions);
			console.log('Sent email to '+lc.name);
			if(fakeEmail) {
				console.log(nodemailer.getTestMessageUrl(info));
			}
		} catch(err) {
			console.log("There was an error while sending message to LC "+lc.name);
		}
	}

}

function prepareArrays(open,accepted,inProgress,approved) {

	var openNew = open.reduce((a,el) => {
		var res,found;
		
		found = a.find(acc => acc.person.id==el.person.id);
		if(found == undefined) {
			res = {
				count: 1,
				person: {
					id: el.person.id,
					url: el.person.url,
					full_name: el.person.full_name,
					email: el.person.email,
					home_lc: el.person.home_lc
				}
			};
			a.push(res);
		}
		else 
			found.count++;
		return a;
	},Array.from([]));

	var acceptedNew = accepted;
	var inProgressNew = inProgress.map(el => {
		el.hasLDM = el.permissions.has_completed_ldm;
		el.hasPayed = el.permissions.has_paid_for_match;
		return el;
	});


	return {
		openNew: openNew,
		acceptedNew: acceptedNew,
		inProgressNew: inProgressNew,
		approvedNew: approved,
	};
}

function mustacheMCRender(open,accepted,inProgress,approved,lcs) {
	var template = fs.readFileSync(MC_PDF_TEMPLATE).toString('utf8');
	var mapIntoLCs = function (arr,lcs) {
		return lcs.map(el => {
			var filtered = arr.filter(app => app.person.home_lc.id == el.id );
			return {name: el.name,code:el.name.toLowerCase().replace(/[^a-z]/g,''),count: filtered.length,filtered: filtered};
		});
	}

	var res = prepareArrays(open,accepted,inProgress,approved);

	try {
	lcs_open = mapIntoLCs(res.openNew,lcs);
	lcs_accepted = mapIntoLCs(res.acceptedNew,lcs);
	lcs_inProgress = mapIntoLCs(res.inProgressNew,lcs);
	lcs_approved = mapIntoLCs(res.approvedNew,lcs);

	var data = {
		openNo: res.openNew.length,
		acceptedNo: res.acceptedNew.length,
		inProgressNo: res.inProgressNew.length,
		approvedNo: res.approvedNew.length,
		lcs_open: lcs_open.filter(el => el.count>0),
		lcs_accepted: lcs_accepted.filter(el => el.count>0),
		lcs_inProgress: lcs_inProgress.filter(el => el.count>0),
		lcs_approved: lcs_approved.filter(el => el.count>0),
	}
	}catch(err) {
		console.log("Mustache MC Render");
		console.log(err);
	}

	return mustache.render(template,data);
}

function mustacheRender(open,accepted,inProgress,approved,lc) {
	var template = fs.readFileSync(MAIL_TEMPLATE).toString('utf8');

	var res = prepareArrays(open,accepted,inProgress,approved);

	var data = {
		lc: lc,
		openNo: res.openNew.length,
		acceptedNo: res.acceptedNew.length,
		inProgressNo: res.inProgressNew.length,
		approvedNo: res.approvedNew.length,
		open: res.openNew,
		accepted: res.acceptedNew,
		inProgress: res.inProgressNew,
		approved: res.approvedNew,
	}

	var rendered = mustache.render(template,data);
	
	return rendered;
}

function sendEmail(email,mailOptions) {
	var p = new Promise((resolve,reject) => email.sendMail(mailOptions, (error, info) => {
		if(error) reject(error);
		resolve(info);
	}));

	p.catch(err => {
		console.log(err);
	});
	return p;
}

function filterAndFormatApplicationByStatus(apps,status) {
	const PEOPLE_URL="https://experience.aiesec.org/#/people/"
	const OPPORTUNITY_URL="https://experience.aiesec.org/#/opportunity/"

	return apps.filter(el => el.status==status).map(el => ({
		id : el.id,
		person : {
			id: el.person.id,
			email: el.person.email,
			url: PEOPLE_URL+el.person.id+"/applications",
			full_name: el.person.full_name,
			ldm_to_complete: el.person.ldm_to_complete,
			home_lc: el.person.home_lc,
		},
		an_signed_at: el.an_signed_at,
		opportunity: {
			id: el.opportunity.id,
			url: OPPORTUNITY_URL+el.opportunity.id,
			office: {
				id: el.opportunity.office.id,
				name: el.opportunity.office.name,
				country: el.opportunity.office.country,
			}
		},
		permissions: el.permissions,
		updated_at: el.updated_at,
	}));
}


async function getOGVApplications(start,lc) {
	try {

		var params = {
			page : 1,
			per_page : 1,
			'filters[created_at][from]' : start,
			'filters[person_committee]' : lc,
			'filters[programmes][]' : PRODUCT.oGV.programme,
		};
		
		return await getApplicationsFromEXPA(params);
	}
	catch(err) {
		console.log("getOGVApplications Failed!");
		console.error(err);
	}
}

async function getApplicationsFromEXPA(params) {
	var res;
	var promises = [];
	var retrieved = 0;
	var total_items = 0;
	var obj;

	console.log("Getting number of total items from EXPA...");
	console.time("Timer");
	res = await getWithPaging(applicationsUrl,params);
	total_items = res.paging.total_items;
	const total_pages = Math.ceil(total_items/PER_PAGE);
	params.per_page = PER_PAGE;
	console.log("Done! Total items: "+total_items);
	console.log("Per page: "+PER_PAGE+", Total Pages: "+total_pages);
	console.timeEnd("Timer");

	do {

		var i = 0;

		console.log("Bulk retrieving pages...");
		while(i++ < PARALLEL && total_pages >= params.page) {
			console.log(params.page);

			promises.push(getWithPaging(applicationsUrl,Object.assign({},params)));
			params.page++;
		}

		console.log("Waiting for pages...");
		var data = await Promise.all(promises);
		console.log("Done!");
		
		//console.log(promises); //Prints promises
		retrieved += PER_PAGE*PARALLEL;

	} while(retrieved < total_items);


	return data.map(el => el.data).reduce((a,c) => a.concat(c));
}


function getStartDate() {
	return '2018-02-01'
	/*
	var today_midnight = new Date();
	today_midnight.setUTCHours(0);
	today_midnight.setUTCMinutes(0);
	today_midnight.setUTCSeconds(0,0);
	return new Date(today_midnight.getTime()-1*24*3600*1000).toISOString().substr(0,10);*/
}

async function getWithPaging(url,data,tries){
	if(!tries) tries = 1;

	return req(expa.get,url,data).then(res => {
		if(!res.paging) throw res;
		console.log("Retrieved page: "+res.paging.current_page);
		return res;
	}).catch(err => {
		console.log("Retrieving info failed for page "+data.page+", retrying... "+(err?JSON.stringify(err):""));
		if(tries<=3) {
			return getWithPaging(url,data,++tries);
		}
		else {
			throw Error("Too many tries while retrieving page "+data.page+" in EXPA");
		}
	})

}
//Function definition. Interactions with node-gis-wrapper functions to use ES6 Promises
async function post(url,data){return req(expa.post,url,data);}
async function patch(url,data){return req(expa.patch,url,data);};
async function req(fn,url,data){return fn(url,data).then(msg => Promise.resolve(msg)).catch(err => Promise.reject(err));}
